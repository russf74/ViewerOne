/**
 * ViewerOne — CrowPanel Advanced 7" ESP32-P4 (EK79007 MIPI-DSI 1024×600 + GT911)
 *
 * PC @ 115200 — display:
 *   {"t":"Title","c":"1999","d":"04:32","l":true,"m":false,"a":false}
 *
 * PC @ 115200 — LED (optional, crowpanel-7-p4-led env):
 *   {"led":"pattern","id":0} / brightness / off / status
 * PC @ 115200 — prompt indicators:
 *   {"prompt":1,"on":true} / {"prompt":2,"on":false}
 *
 * ESP→PC touch:
 *   {"evt":"mute_toggle","group":"fx"}     FX pad / main text stage (Group6)
 *   {"evt":"mute_toggle","group":"all"}    Group1 / ALL pad
 * Boot/identity: {"evt":"boot","device":"crowpanel7","model":"Elecrow CrowPanel Advanced 7","w":1024,"h":600,...}
 * PC may request it again with {"cmd":"hello"}.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <cstring>
#include <esp_err.h>
#include <esp_idf_version.h>
#include <esp_ldo_regulator.h>
#include <esp_task_wdt.h>

#include "board_config.h"
#include "esp_panel_board_custom_conf.h"
#include "esp_panel_drivers_conf.h"
#include <esp_display_panel.hpp>
#include "led_config.h"
#include "lv_conf.h"
#include "lvgl.h"
#include "lvgl_v8_port.h"
#include "patterns.h"

#if defined(VIEWERONE_ENABLE_LED)
#include <FastLED.h>
static CRGB s_leds[NUM_LEDS];
#endif

using namespace esp_panel::drivers;
using namespace esp_panel::board;

static constexpr const char *VIEWERONE_FW_VERSION = "5.10.0";
static constexpr uint32_t WDT_TIMEOUT_S = 8;

static constexpr int SCREEN_W = H_size;
static constexpr int SCREEN_H = V_size;
static constexpr int PAD_COL_W = 260;
static constexpr int MAIN_W = SCREEN_W - PAD_COL_W;
static constexpr int PAD_COUNT = 4;
static constexpr uint32_t PAD_COOLDOWN_MS = 120;

static constexpr int kMainPad = 18;
static constexpr int kBrandH = 34;
static constexpr int kFooterH = 38;
static constexpr int kTextBoxPad = 16;
static constexpr int kTextBoxTopGap = 14;  // below brand — keeps title clear of header
static constexpr int kTextBoxBotGap = 10;

/** LVGL built-in Montserrat tops out at 48px; zoom (256 = 1x) matches PC preview proportions on 1024×600. */
static constexpr uint16_t kTitleZoom = 400;  // ~75px visual
static constexpr uint16_t kYearZoom = 330;   // ~62px visual; fits "YYYY     MM:SS"
static constexpr uint16_t kIdleZoom = 400;   // ~75px visual

/** Grow down/right from top-left so left-justified layout stays inside the text box. */
static void applyTextZoom(lv_obj_t *obj, uint16_t zoom) {
  lv_obj_set_style_transform_zoom(obj, zoom, 0);
  lv_obj_set_style_transform_pivot_x(obj, 0, 0);
  lv_obj_set_style_transform_pivot_y(obj, 0, 0);
}

/** Logical label width so post-zoom text fits the faint text box. */
static int textBoxLabelW(uint16_t zoom) {
  const int main_w = MAIN_W - 12;
  const int box_w = main_w - 2 * kMainPad;
  const int content_w = box_w - 2 * kTextBoxPad;
  return content_w * 256 / (int)zoom;
}

// GPIO29 = LCD_BK_POWER on CrowPanel Advanced (wiki); EN/PWM is IO31 via panel lib.
static constexpr int PIN_LCD_BK_POWER = 29;

enum PadId : uint8_t {
  PAD_ALL = 0,
  PAD_FX = 1,
  PAD_PROMPT_1 = 2,
  PAD_PROMPT_2 = 3,
};

static const char *const kPadLabels[PAD_COUNT] = {"ALL", "FX", "PROMPT 1", "PROMPT 2"};

static char s_title[160] = "Waiting";
static char s_year[48] = "";
static bool s_fx_muted = false;
static bool s_showing_waiting = true;
/** ALL/FX: muted state. PROMPT 1/2: illuminated state. */
static bool s_pad_muted[PAD_COUNT] = {false, false, false, false};
static PatternId s_pattern = DEFAULT_PATTERN;

static lv_obj_t *s_scr = nullptr;
static lv_obj_t *s_main = nullptr;
static lv_obj_t *s_brand = nullptr;
static lv_obj_t *s_text_box = nullptr;
static lv_obj_t *s_title_lbl = nullptr;
static lv_obj_t *s_year_lbl = nullptr;
static lv_obj_t *s_footer_lbl = nullptr;
static lv_obj_t *s_idle_lbl = nullptr;
static lv_obj_t *s_pad_btns[PAD_COUNT] = {nullptr};
static lv_obj_t *s_pad_status[PAD_COUNT] = {nullptr};

static String lineBuf;
static uint32_t s_last_pad_ms[PAD_COUNT] = {0};

static lv_color_t col_hex(uint32_t rgb) { return lv_color_hex(rgb); }

static void applyMainTheme(bool muted) {
  if (!s_main) return;
  const lv_color_t bg = muted ? col_hex(0x000088) : col_hex(0x050608);
  const lv_color_t fg = muted ? col_hex(0xFFE600) : col_hex(0x39FF14);
  lv_obj_set_style_bg_color(s_main, bg, 0);
  if (s_title_lbl) lv_obj_set_style_text_color(s_title_lbl, fg, 0);
  if (s_year_lbl) lv_obj_set_style_text_color(s_year_lbl, fg, 0);
  if (s_footer_lbl) lv_obj_set_style_text_color(s_footer_lbl, fg, 0);
  if (s_idle_lbl) lv_obj_set_style_text_color(s_idle_lbl, col_hex(0xFFE600), 0);
  if (s_brand) {
    lv_obj_set_style_text_color(s_brand, muted ? col_hex(0xC9B44A) : col_hex(0x6B7280), 0);
  }
}

static void refreshPadVisual(int idx) {
  if (idx < 0 || idx >= PAD_COUNT || !s_pad_btns[idx]) return;
  const bool active = s_pad_muted[idx];
  const bool indicator = idx == PAD_PROMPT_1 || idx == PAD_PROMPT_2;
  lv_color_t bg;
  lv_color_t border;
  lv_color_t fg;
  if (idx == PAD_PROMPT_1 && active) {
    bg = col_hex(0xFF1493);
    border = col_hex(0xFF9AD1);
    fg = col_hex(0xFFFFFF);
  } else if (idx == PAD_PROMPT_2 && active) {
    bg = col_hex(0xFFD600);
    border = col_hex(0xFFF176);
    fg = col_hex(0x171300);
  } else if (indicator) {
    bg = col_hex(0x11151C);
    border = col_hex(0x252C37);
    fg = col_hex(0x737D8E);
  } else if (idx == PAD_FX && active) {
    bg = col_hex(0x000088);
    border = col_hex(0x2E8BFF);
    fg = col_hex(0xEAF4FF);
  } else if (active) {
    bg = col_hex(0x5C1A1A);
    border = col_hex(0xFF6A00);
    fg = col_hex(0xFFCC66);
  } else {
    bg = col_hex(0x0F2A18);
    border = col_hex(0x2ECC71);
    fg = col_hex(0xB8F5C8);
  }
  lv_obj_set_style_bg_color(s_pad_btns[idx], bg, 0);
  lv_obj_set_style_border_color(s_pad_btns[idx], border, 0);
  lv_obj_set_style_text_color(s_pad_btns[idx], fg, 0);
  if (s_pad_status[idx]) {
    lv_label_set_text(s_pad_status[idx],
                      indicator ? (active ? "ON" : "STANDBY") : (active ? "MUTED" : "LIVE"));
    lv_obj_set_style_text_color(
        s_pad_status[idx],
        idx == PAD_PROMPT_1 && active
            ? col_hex(0xFFFFFF)
            : idx == PAD_PROMPT_2 && active
                  ? col_hex(0x171300)
                  : indicator
                        ? col_hex(0x596170)
                        : (active ? (idx == PAD_FX ? col_hex(0x9DCEFF) : col_hex(0xFF8A4C))
                                  : col_hex(0x5CDE8A)),
        0);
  }
}

static void refreshFooter() {
  if (!s_footer_lbl) return;
  char label[48];
  patternLabelDisplay(s_pattern, label, sizeof(label));
  lv_label_set_text(s_footer_lbl, label);
}

static void showWaitingUi(bool waiting) {
  s_showing_waiting = waiting;
  if (s_idle_lbl) {
    if (waiting) {
      lv_obj_clear_flag(s_idle_lbl, LV_OBJ_FLAG_HIDDEN);
      lv_label_set_text(s_idle_lbl, "Waiting for signal");
    } else {
      lv_obj_add_flag(s_idle_lbl, LV_OBJ_FLAG_HIDDEN);
    }
  }
  if (s_title_lbl) {
    if (waiting) {
      lv_obj_add_flag(s_title_lbl, LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_clear_flag(s_title_lbl, LV_OBJ_FLAG_HIDDEN);
    }
  }
  if (s_year_lbl) {
    if (waiting) {
      lv_obj_add_flag(s_year_lbl, LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_clear_flag(s_year_lbl, LV_OBJ_FLAG_HIDDEN);
    }
  }
}

/** Keep year about half one zoomed title line below the actual (possibly wrapped) title. */
static void positionYearBelowTitle() {
  if (!s_title_lbl || !s_year_lbl) return;
  lv_obj_update_layout(s_title_lbl);
  const int title_y = 28;
  const int title_visual_h = lv_obj_get_height(s_title_lbl) * (int)kTitleZoom / 256;
  const int title_visual_font_h = 48 * (int)kTitleZoom / 256;
  lv_obj_set_y(s_year_lbl, title_y + title_visual_h + title_visual_font_h / 2);
}

static void drawSongUi(const char *title, const char *year, const char *duration, bool muted) {
  strncpy(s_title, title && title[0] ? title : "-", sizeof(s_title) - 1);
  s_title[sizeof(s_title) - 1] = '\0';
  const char *safe_year = year ? year : "";
  const char *safe_duration = duration ? duration : "";
  if (safe_year[0] && safe_duration[0]) {
    snprintf(s_year, sizeof(s_year), "%s     %s", safe_year, safe_duration);
  } else {
    snprintf(s_year, sizeof(s_year), "%s%s", safe_year, safe_duration);
  }
  s_fx_muted = muted;
  s_pad_muted[PAD_FX] = muted;
  showWaitingUi(false);
  if (s_title_lbl) lv_label_set_text(s_title_lbl, s_title);
  if (s_year_lbl) lv_label_set_text(s_year_lbl, s_year[0] ? s_year : "-");
  positionYearBelowTitle();
  applyMainTheme(muted);
  refreshPadVisual(PAD_FX);
  refreshFooter();
}

static void drawWaitingUi() {
  s_fx_muted = false;
  s_pad_muted[PAD_FX] = false;
  strncpy(s_title, "Waiting", sizeof(s_title) - 1);
  s_year[0] = '\0';
  showWaitingUi(true);
  applyMainTheme(false);
  refreshPadVisual(PAD_FX);
  refreshFooter();
}

static void sendMuteEvent(const char *group) {
  // One JSON line only (avoid double-toggle). Bare mute_toggle remains CYD firmware.
  // CrowPanel always includes group; desktop ignores unknown groups and treats fx/all/missing.
  if (!group || !group[0]) {
    Serial.println("{\"evt\":\"mute_toggle\"}");
    return;
  }
  Serial.printf("{\"evt\":\"mute_toggle\",\"group\":\"%s\"}\n", group);
}

/** Present optimistic mute styling before notifying the desktop over serial. */
static void presentLocalUiNow() {
  lv_refr_now(lv_disp_get_default());
}

static void sendDeviceIdentity(const char *evt) {
  Serial.printf(
      "{\"evt\":\"%s\",\"device\":\"crowpanel7\",\"model\":\"Elecrow CrowPanel Advanced 7\","
      "\"w\":1024,\"h\":600,\"fw\":\"%s\",\"led_id\":%u,\"led\":\"%s\"}\n",
      evt, VIEWERONE_FW_VERSION, (unsigned)s_pattern, patternName(s_pattern));
}

static void onPadPressed(int idx) {
  if (idx < 0 || idx >= PAD_COUNT) return;
  const uint32_t now = millis();
  if (now - s_last_pad_ms[idx] < PAD_COOLDOWN_MS) return;
  s_last_pad_ms[idx] = now;

  if (idx == PAD_ALL) {
    s_pad_muted[PAD_ALL] = !s_pad_muted[PAD_ALL];
    refreshPadVisual(PAD_ALL);
    presentLocalUiNow();
    sendMuteEvent("all");
    return;
  }
  if (idx == PAD_FX) {
    // Optimistic local flip; PC echo via {"m":...} is authoritative.
    s_pad_muted[PAD_FX] = !s_pad_muted[PAD_FX];
    s_fx_muted = s_pad_muted[PAD_FX];
    applyMainTheme(s_fx_muted);
    refreshPadVisual(PAD_FX);
    presentLocalUiNow();
    sendMuteEvent("fx");
    return;
  }
  // PROMPT indicators are serial-driven and deliberately non-clickable.
}

static void pad_event_cb(lv_event_t *e) {
  if (lv_event_get_code(e) != LV_EVENT_PRESSED) return;
  const int idx = (int)(intptr_t)lv_event_get_user_data(e);
  onPadPressed(idx);
}

/** Whole left stage / text box — same as CYD screen tap (Group 6 / FX). */
static void stage_mute_cb(lv_event_t *e) {
  if (lv_event_get_code(e) != LV_EVENT_PRESSED) return;
  onPadPressed(PAD_FX);
}

static void buildUi() {
  s_scr = lv_scr_act();
  lv_obj_set_style_bg_color(s_scr, col_hex(0x0A0C10), 0);
  lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);
  lv_obj_clear_flag(s_scr, LV_OBJ_FLAG_SCROLLABLE);

  const int main_w = MAIN_W - 12;
  const int main_h = SCREEN_H - 16;
  const int box_w = main_w - 2 * kMainPad;
  const int box_h =
      main_h - 2 * kMainPad - kBrandH - kTextBoxTopGap - kFooterH - kTextBoxBotGap;

  // Left / main stage
  s_main = lv_obj_create(s_scr);
  lv_obj_set_size(s_main, main_w, main_h);
  lv_obj_set_pos(s_main, 8, 8);
  lv_obj_set_style_radius(s_main, 18, 0);
  lv_obj_set_style_border_width(s_main, 1, 0);
  lv_obj_set_style_border_color(s_main, col_hex(0x1E2430), 0);
  lv_obj_set_style_pad_all(s_main, kMainPad, 0);
  lv_obj_set_style_shadow_width(s_main, 24, 0);
  lv_obj_set_style_shadow_opa(s_main, LV_OPA_40, 0);
  lv_obj_set_style_shadow_color(s_main, col_hex(0x000000), 0);
  lv_obj_clear_flag(s_main, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_add_flag(s_main, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(s_main, stage_mute_cb, LV_EVENT_PRESSED, nullptr);

  s_brand = lv_label_create(s_main);
  lv_label_set_text(s_brand, "VIEWERONE  -  LIVE HMI");
  lv_obj_set_style_text_font(s_brand, &lv_font_montserrat_22, 0);
  lv_obj_set_style_text_letter_space(s_brand, 3, 0);
  lv_obj_align(s_brand, LV_ALIGN_TOP_LEFT, 0, 0);
  lv_obj_clear_flag(s_brand, LV_OBJ_FLAG_CLICKABLE);

  s_footer_lbl = lv_label_create(s_main);
  lv_obj_set_style_text_font(s_footer_lbl, &lv_font_montserrat_28, 0);
  lv_obj_align(s_footer_lbl, LV_ALIGN_BOTTOM_LEFT, 0, 0);
  lv_obj_clear_flag(s_footer_lbl, LV_OBJ_FLAG_CLICKABLE);

  // Faint content box — song/idle text lives only inside these edges
  s_text_box = lv_obj_create(s_main);
  lv_obj_set_size(s_text_box, box_w, box_h);
  lv_obj_align(s_text_box, LV_ALIGN_TOP_LEFT, 0, kBrandH + kTextBoxTopGap);
  lv_obj_set_style_bg_opa(s_text_box, LV_OPA_10, 0);
  lv_obj_set_style_bg_color(s_text_box, col_hex(0xFFFFFF), 0);
  lv_obj_set_style_border_width(s_text_box, 1, 0);
  lv_obj_set_style_border_color(s_text_box, col_hex(0x6B7280), 0);
  lv_obj_set_style_border_opa(s_text_box, LV_OPA_40, 0);
  lv_obj_set_style_radius(s_text_box, 12, 0);
  lv_obj_set_style_pad_all(s_text_box, kTextBoxPad, 0);
  lv_obj_clear_flag(s_text_box, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(s_text_box, LV_OBJ_FLAG_OVERFLOW_VISIBLE);
  lv_obj_add_flag(s_text_box, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(s_text_box, stage_mute_cb, LV_EVENT_PRESSED, nullptr);

  s_idle_lbl = lv_label_create(s_text_box);
  lv_label_set_text(s_idle_lbl, "Waiting for signal");
  lv_label_set_long_mode(s_idle_lbl, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(s_idle_lbl, textBoxLabelW(kIdleZoom));
  lv_obj_set_style_text_font(s_idle_lbl, &lv_font_montserrat_48, 0);
  applyTextZoom(s_idle_lbl, kIdleZoom);
  lv_obj_set_style_text_align(s_idle_lbl, LV_TEXT_ALIGN_LEFT, 0);
  lv_obj_align(s_idle_lbl, LV_ALIGN_TOP_LEFT, 0, 56);
  lv_obj_clear_flag(s_idle_lbl, LV_OBJ_FLAG_CLICKABLE);

  s_title_lbl = lv_label_create(s_text_box);
  lv_label_set_long_mode(s_title_lbl, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(s_title_lbl, textBoxLabelW(kTitleZoom));
  lv_obj_set_style_text_font(s_title_lbl, &lv_font_montserrat_48, 0);
  applyTextZoom(s_title_lbl, kTitleZoom);
  lv_obj_set_style_text_align(s_title_lbl, LV_TEXT_ALIGN_LEFT, 0);
  lv_obj_align(s_title_lbl, LV_ALIGN_TOP_LEFT, 0, 28);
  lv_obj_add_flag(s_title_lbl, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(s_title_lbl, LV_OBJ_FLAG_CLICKABLE);

  s_year_lbl = lv_label_create(s_text_box);
  lv_label_set_long_mode(s_year_lbl, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(s_year_lbl, textBoxLabelW(kYearZoom));
  lv_obj_set_style_text_font(s_year_lbl, &lv_font_montserrat_48, 0);
  applyTextZoom(s_year_lbl, kYearZoom);
  lv_obj_set_style_text_align(s_year_lbl, LV_TEXT_ALIGN_LEFT, 0);
  lv_obj_align(s_year_lbl, LV_ALIGN_TOP_LEFT, 0, 200);
  lv_obj_add_flag(s_year_lbl, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(s_year_lbl, LV_OBJ_FLAG_CLICKABLE);

  // Right pad column
  lv_obj_t *col = lv_obj_create(s_scr);
  lv_obj_set_size(col, PAD_COL_W - 10, SCREEN_H - 16);
  lv_obj_set_pos(col, MAIN_W + 2, 8);
  lv_obj_set_style_bg_color(col, col_hex(0x0C0E14), 0);
  lv_obj_set_style_border_width(col, 1, 0);
  lv_obj_set_style_border_color(col, col_hex(0x222833), 0);
  lv_obj_set_style_radius(col, 18, 0);
  lv_obj_set_style_pad_all(col, 12, 0);
  lv_obj_set_style_pad_row(col, 8, 0);
  lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(col, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(col, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *col_title = lv_label_create(col);
  lv_label_set_text(col_title, "CONTROLS");
  lv_obj_set_style_text_font(col_title, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(col_title, col_hex(0x8B92A0), 0);
  lv_obj_set_style_text_letter_space(col_title, 2, 0);

  const int item_w = PAD_COL_W - 36;
  const int item_h = 116;
  for (int i = 0; i < PAD_COUNT; i++) {
    const bool indicator = i == PAD_PROMPT_1 || i == PAD_PROMPT_2;
    s_pad_btns[i] = indicator ? lv_obj_create(col) : lv_btn_create(col);
    lv_obj_set_size(s_pad_btns[i], item_w, item_h);
    lv_obj_set_style_radius(s_pad_btns[i], 12, 0);
    lv_obj_set_style_border_width(s_pad_btns[i], 2, 0);
    lv_obj_set_style_pad_all(s_pad_btns[i], 8, 0);
    lv_obj_clear_flag(s_pad_btns[i], LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_shadow_width(s_pad_btns[i], indicator ? 3 : 12, 0);
    lv_obj_set_style_shadow_opa(s_pad_btns[i], indicator ? LV_OPA_20 : LV_OPA_50, 0);
    lv_obj_set_style_shadow_color(s_pad_btns[i], col_hex(0x000000), 0);
    if (indicator) {
      lv_obj_clear_flag(s_pad_btns[i], LV_OBJ_FLAG_CLICKABLE);
    } else {
      lv_obj_add_event_cb(s_pad_btns[i], pad_event_cb, LV_EVENT_PRESSED, (void *)(intptr_t)i);
    }

    lv_obj_t *lbl = lv_label_create(s_pad_btns[i]);
    lv_label_set_text(lbl, kPadLabels[i]);
    lv_obj_set_style_text_font(lbl, indicator ? &lv_font_montserrat_24 : &lv_font_montserrat_28, 0);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, -10);
    lv_obj_clear_flag(lbl, LV_OBJ_FLAG_CLICKABLE);

    s_pad_status[i] = lv_label_create(s_pad_btns[i]);
    lv_obj_set_style_text_font(s_pad_status[i], &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_letter_space(s_pad_status[i], 2, 0);
    lv_obj_align(s_pad_status[i], LV_ALIGN_BOTTOM_MID, 0, -8);
    lv_obj_clear_flag(s_pad_status[i], LV_OBJ_FLAG_CLICKABLE);

    refreshPadVisual(i);
  }

  lv_obj_t *ver = lv_label_create(col);
  char vbuf[40];
  snprintf(vbuf, sizeof(vbuf), "v%s", VIEWERONE_FW_VERSION);
  lv_label_set_text(ver, vbuf);
  lv_obj_set_style_text_font(ver, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(ver, col_hex(0x4B5563), 0);

  drawWaitingUi();
}

#if defined(VIEWERONE_ENABLE_LED)
static PatternId parsePatternId(JsonVariantConst idField, JsonVariantConst nameField) {
  if (!nameField.isNull()) {
    const char *n = nameField.as<const char *>();
    if (n) {
      for (uint8_t i = 0; i < PATTERN_COUNT; i++) {
        if (strcasecmp(n, patternName((PatternId)i)) == 0) return (PatternId)i;
      }
      if (strcasecmp(n, "blackout") == 0) return PATTERN_BLACKOUT;
      if (strcasecmp(n, "off") == 0 || strcasecmp(n, "stop") == 0) return PATTERN_OFF;
    }
  }
  if (!idField.isNull()) {
    int n = idField.as<int>();
    if (n >= 0 && n < PATTERN_COUNT) return (PatternId)n;
    if (n == (int)PATTERN_BLACKOUT) return PATTERN_BLACKOUT;
    if (n == 255) return PATTERN_OFF;
  }
  return (PatternId)254;
}

static void replyLedOk(const char *detail) {
  Serial.printf("{\"evt\":\"led\",\"ok\":true,%s}\n", detail);
}
static void replyLedErr(const char *msg) {
  Serial.printf("{\"evt\":\"led\",\"ok\":false,\"err\":\"%s\"}\n", msg);
}

static void handleLedCommand(JsonDocument &doc) {
  const char *cmd = doc["led"] | "";
  if (!cmd[0]) {
    replyLedErr("missing_led_cmd");
    return;
  }
  if (strcasecmp(cmd, "pattern") == 0 || strcasecmp(cmd, "p") == 0) {
    PatternId id = parsePatternId(doc["id"], doc["name"]);
    if ((uint8_t)id == 254) {
      replyLedErr("unknown_pattern");
      return;
    }
    patternsSet(id);
    s_pattern = id;
    if (lvgl_port_lock(50)) {
      refreshFooter();
      lvgl_port_unlock();
    }
    char detail[64];
    snprintf(detail, sizeof(detail), "\"cmd\":\"pattern\",\"id\":%u,\"name\":\"%s\"", (unsigned)id,
             patternName(id));
    replyLedOk(detail);
    return;
  }
  if (strcasecmp(cmd, "brightness") == 0 || strcasecmp(cmd, "bri") == 0) {
    if (doc["v"].isNull()) {
      replyLedErr("brightness_needs_v");
      return;
    }
    int v = doc["v"].as<int>();
    if (v < 0 || v > 255) {
      replyLedErr("brightness_0_255");
      return;
    }
    patternsSetBrightness((uint8_t)v);
    char detail[40];
    snprintf(detail, sizeof(detail), "\"cmd\":\"brightness\",\"v\":%d", v);
    replyLedOk(detail);
    return;
  }
  if (strcasecmp(cmd, "off") == 0 || strcasecmp(cmd, "stop") == 0) {
    patternsSet(PATTERN_OFF);
    s_pattern = PATTERN_OFF;
    if (lvgl_port_lock(50)) {
      refreshFooter();
      lvgl_port_unlock();
    }
    replyLedOk("\"cmd\":\"off\",\"name\":\"off\"");
    return;
  }
  if (strcasecmp(cmd, "status") == 0) {
    char detail[96];
    snprintf(detail, sizeof(detail),
             "\"cmd\":\"status\",\"id\":%u,\"name\":\"%s\",\"brightness\":%u,\"leds\":%u,\"pin\":%d",
             (unsigned)patternsCurrent(), patternName(patternsCurrent()),
             (unsigned)FastLED.getBrightness(), (unsigned)NUM_LEDS, (int)PIN_LED_DATA);
    replyLedOk(detail);
    return;
  }
  replyLedErr("unknown_led_cmd");
}
#else
static void handleLedCommand(JsonDocument &doc) {
  (void)doc;
  Serial.println("{\"evt\":\"led\",\"ok\":false,\"err\":\"led_disabled\"}");
}
#endif

static void handlePromptCommand(JsonDocument &doc) {
  const int prompt = doc["prompt"] | 0;
  if ((prompt != 1 && prompt != 2) || doc["on"].isNull()) {
    Serial.println("{\"evt\":\"prompt\",\"ok\":false,\"err\":\"prompt_needs_1_or_2_and_on\"}");
    return;
  }
  const bool on = doc["on"].as<bool>();
  const int idx = prompt == 1 ? PAD_PROMPT_1 : PAD_PROMPT_2;
  if (lvgl_port_lock(-1)) {
    s_pad_muted[idx] = on;
    refreshPadVisual(idx);
    lvgl_port_unlock();
  }
  Serial.printf("{\"evt\":\"prompt\",\"ok\":true,\"prompt\":%d,\"on\":%s}\n", prompt,
                on ? "true" : "false");
}

static void handleSerialLine(const String &line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;

  const char *cmd = doc["cmd"] | "";
  if (strcasecmp(cmd, "hello") == 0) {
    sendDeviceIdentity("hello");
    return;
  }

  if (!doc["prompt"].isNull()) {
    handlePromptCommand(doc);
    return;
  }
  if (!doc["led"].isNull()) {
    handleLedCommand(doc);
    return;
  }
  if (doc["t"].isNull()) return;

  const char *t = doc["t"] | "";
  const char *c = doc["c"] | "";
  const char *d = doc["d"] | "";
  bool m = doc["m"] | false;
  const bool has_all = !doc["a"].isNull();
  const bool all_muted = doc["a"] | false;

  if (lvgl_port_lock(-1)) {
    drawSongUi(t, c, d, m);
    if (has_all) {
      s_pad_muted[PAD_ALL] = all_muted;
      refreshPadVisual(PAD_ALL);
    }
    lvgl_port_unlock();
  }
}

static bool initPanelPower() {
  esp_err_t err = ESP_OK;
  esp_ldo_channel_handle_t ldo3 = nullptr;
  esp_ldo_channel_config_t ldo3_cfg = {.chan_id = 3, .voltage_mv = 2500};
  err = esp_ldo_acquire_channel(&ldo3_cfg, &ldo3);
  if (err != ESP_OK) {
    Serial.printf("LDO3 (MIPI PHY) error: %s\n", esp_err_to_name(err));
  }

  esp_ldo_channel_handle_t ldo4 = nullptr;
  esp_ldo_channel_config_t ldo4_cfg = {.chan_id = 4, .voltage_mv = 3300};
  err = esp_ldo_acquire_channel(&ldo4_cfg, &ldo4);
  if (err != ESP_OK) {
    Serial.printf("LDO4 (I2C/touch) error: %s\n", esp_err_to_name(err));
  }

  pinMode(PIN_LCD_BK_POWER, OUTPUT);
  digitalWrite(PIN_LCD_BK_POWER, HIGH);
  return true;
}

void setup() {
  Serial.begin(115200);
  lineBuf.reserve(512);
  delay(200);

#if ESP_IDF_VERSION_MAJOR >= 5
  const esp_task_wdt_config_t wdtConfig = {
      .timeout_ms = WDT_TIMEOUT_S * 1000,
      .idle_core_mask = (1U << portNUM_PROCESSORS) - 1U,
      .trigger_panic = true,
  };
  esp_task_wdt_init(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);

  Serial.printf("ViewerOne CrowPanel 7\" P4 v%s booting...\n", VIEWERONE_FW_VERSION);
  initPanelPower();

  Board *board = new Board();
  Serial.println("Initializing EK79007 + GT911...");
  if (!board->init()) {
    Serial.println("Board init failed");
    return;
  }
#if LVGL_PORT_AVOID_TEARING_MODE
  auto lcd = board->getLCD();
  if (lcd) lcd->configFrameBufferNumber(LVGL_PORT_DISP_BUFFER_NUM);
#endif
  if (!board->begin()) {
    Serial.println("Board begin failed");
    return;
  }

  if (!lvgl_port_init(board->getLCD(), board->getTouch())) {
    Serial.println("LVGL port init failed");
    return;
  }

  if (lvgl_port_lock(-1)) {
    buildUi();
    lvgl_port_unlock();
  }

#if defined(VIEWERONE_ENABLE_LED)
  FastLED.addLeds<WS2812B, PIN_LED_DATA, GRB>(s_leds, NUM_LEDS);
  FastLED.setBrightness(LED_BRIGHTNESS);
  FastLED.clear(true);
  patternsBegin(s_leds, NUM_LEDS);
  s_pattern = patternsCurrent();
#endif

  Serial.printf("ViewerOne CrowPanel ready @ 115200 (LVGL, GT911 touch");
#if defined(VIEWERONE_ENABLE_LED)
  Serial.printf(", LED GPIO%d x%u", (int)PIN_LED_DATA, (unsigned)NUM_LEDS);
#else
  Serial.printf(", LED stub");
#endif
  Serial.println(")");
  sendDeviceIdentity("boot");
}

void loop() {
  esp_task_wdt_reset();

  while (Serial.available()) {
    char ch = static_cast<char>(Serial.read());
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (lineBuf.length() == 0) continue;
      handleSerialLine(lineBuf);
      lineBuf = "";
    } else if (lineBuf.length() < 480) {
      lineBuf += ch;
    }
  }

#if defined(VIEWERONE_ENABLE_LED)
  patternsTick();
  if (patternsConsumeFooterDirty()) {
    s_pattern = patternsCurrent();
    if (lvgl_port_lock(20)) {
      refreshFooter();
      lvgl_port_unlock();
    }
  }
#endif

  delay(2);
}
