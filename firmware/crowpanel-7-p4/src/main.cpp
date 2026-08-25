/**
 * ViewerOne — CrowPanel Advanced 7" ESP32-P4 (EK79007 MIPI-DSI 1024×600 + GT911)
 *
 * PC @ 115200 — display (transport / song change only — not every second):
 *   {"t":"Title","c":"1999","d":"04:32","n":"01/24","x":"Next Title","r":272,"p":true,"tr":1,"g":"01/24 · 41m","l":true,"m":false,"a":false,"s":false,"i":false}
 *   Rapid song lines coalesce (~50ms, latest wins) before LVGL apply — avoids WDT cyan reboot.
 *   m=FX, a=ALL, s=Synth (Cubase ch1), i=Piano (Cubase ch2) mute flags.
 *   n = setlist position (`01/24`, `IN/24`, `SC/24`, `OU/24`) — updates with song UI only.
 *   x = next setlist row title — hard-clipped (no ellipsis); label updates only when x changes.
 *   r = remaining seconds, p = playing. Firmware ticks MM:SS locally while p=true
 *   so USB serial does not stall WS2812 refresh each second.
 *   tr = Cubase transport 1=playing / 0=stopped (brand-bar PLAY/STOP; even without MIDI clock).
 *   g = set progress under pad clock (`12/30 · 41m`) — song/setlist change only.
 *   Duration is a narrow LVGL label; 1Hz updates are deferred (dirty flag) and LED
 *   refresh runs on a high-priority task on the opposite core from LVGL.
 * PC @ 115200 — wall clock (host has RTC; ESP does not):
 *   {"hm":"14:05"}  (alias: "clk") — right-pad-column top HH:MM; label set only when string changes.
 *
 * PC @ 115200 — LED (optional, crowpanel-7-p4-led env):
 *   {"led":"pattern","id":0} / brightness / off / status
 * PC @ 115200 — legacy prompt JSON is accepted but no longer drives pads
 *   (bottom pads are Cubase channel mutes: Synth / Piano).
 *
 * ESP→PC touch:
 *   {"evt":"mute_toggle","group":"fx","muted":true|false}     FX pad / main text stage (Group6)
 *   {"evt":"mute_toggle","group":"all","muted":true|false}  Group1 / ALL — absolute after local flip
 *   {"evt":"mute_toggle","group":"synth","muted":true|false}  Cubase ch1 — absolute after local flip
 *   {"evt":"mute_toggle","group":"piano","muted":true|false}  Cubase ch2 — absolute after local flip
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
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

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

static constexpr const char *VIEWERONE_FW_VERSION = "5.12.41";
static constexpr uint32_t WDT_TIMEOUT_S = 8;

static constexpr int SCREEN_W = H_size;
static constexpr int SCREEN_H = V_size;
static constexpr int PAD_COL_W = 260;
static constexpr int MAIN_W = SCREEN_W - PAD_COL_W;
static constexpr int PAD_COUNT = 4;
/** Anti-chatter — long enough to avoid double mute_toggle from GT911 bounce. */
static constexpr uint32_t PAD_COOLDOWN_MS = 180;
/** Min gap between full song UI applies — latest pending wins (rapid PC/arranger flicks). */
static constexpr uint32_t SONG_UI_COALESCE_MS = 50;
/** Never block forever on LVGL during song UI (180° rotate flush can be slow). */
static constexpr int LVGL_SONG_LOCK_MS = 40;
/** Drain at most this many serial lines per loop so WDT stays fed under flood. */
static constexpr int SERIAL_LINES_PER_LOOP = 4;

static constexpr int kMainPad = 18;
static constexpr int kBrandH = 34;
static constexpr int kFooterH = 38;
static constexpr int kTextBoxPad = 16;
static constexpr int kTextBoxTopGap = 14;  // below brand — keeps title clear of header
static constexpr int kTextBoxBotGap = 10;

/** LVGL built-in Montserrat tops out at 48px; zoom (256 = 1x) matches PC preview proportions on 1024×600. */
static constexpr uint16_t kTitleZoom = 400;  // ~75px visual
static constexpr uint16_t kYearZoom = 330;   // ~62px visual; fits "YYYY     MM:SS     01/24"
static constexpr uint16_t kNextZoom = 250;   // smaller than meta (~47px visual)
static constexpr uint16_t kIdleZoom = 400;   // ~75px visual
/** Hard cap for now-playing title (host also truncates); no ellipsis — CLIP only. */
static constexpr size_t kTitleMaxChars = 96;
/** Hard cap for next-song title (host also truncates); no ellipsis — CLIP only. */
static constexpr size_t kNextTitleMaxChars = 36;
/** Hard cap for set-progress under clock (host also truncates); CLIP only. */
static constexpr size_t kSetProgressMaxChars = 24;
/** Bottom-align next-song label this many px above the meta band (logical, pre-zoom). */
static constexpr int kNextAboveMeta = 72;

/** Bound-safe copy into dst (always NUL-terminated); at most maxChars of src. */
static void copyBounded(char *dst, size_t dstSize, const char *src, size_t maxChars) {
  if (!dst || dstSize == 0) return;
  dst[0] = '\0';
  if (!src || !src[0]) return;
  size_t n = maxChars;
  if (n > dstSize - 1) n = dstSize - 1;
  strncpy(dst, src, n);
  dst[n] = '\0';
}

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
  PAD_SYNTH = 2,
  PAD_PIANO = 3,
};

static const char *const kPadLabels[PAD_COUNT] = {"ALL", "FX", "SYNTH", "PIANO"};

static char s_title[160] = "Waiting";
/** Year only (from PC `c`); duration is a separate narrow label for 1Hz ticks. */
static char s_year_only[16] = "";
static char s_duration[16] = "";
/** Song position from PC `n` — changes on song select only (not 1Hz). */
static char s_position[16] = "";
/** Next setlist title from PC `x` — song select only (not 1Hz). */
static char s_next[160] = "";
/** Set progress under pad clock from PC `g` — song/setlist change only. */
static char s_set_progress[32] = "";
/** Local wall clock HH:MM from PC `hm` / `clk` — update label only when string changes. */
static char s_clock[8] = "";
/** Cubase transport from PC `tr` (1=playing) — brand-bar PLAY/STOP. */
static bool s_transport_playing = false;
static bool s_fx_muted = false;
static bool s_showing_waiting = true;
/** ALL / FX / Synth / Piano: muted=true means channel/group muted (pad dark). */
static bool s_pad_muted[PAD_COUNT] = {false, false, false, false};
static PatternId s_pattern = DEFAULT_PATTERN;

/** Device-side countdown — host arms via r/p; firmware ticks without per-second USB. */
static int32_t s_cd_remain_sec = -1;
static bool s_cd_running = false;
static uint32_t s_cd_anchor_ms = 0;
static int32_t s_cd_anchor_sec = 0;
static int32_t s_cd_last_shown = -1;
/** Defer LVGL duration label work off the LED critical path (set from tick, cleared under lock). */
static volatile bool s_duration_dirty = false;

/** Latest host display line — applied once from loop (coalesce under rapid song flips). */
struct PendingDisplay {
  char title[160];
  char year[16];
  char duration[16];
  char position[16];
  char next[160];
  char set_progress[32];
  bool muted;
  bool has_transport;
  bool transport_playing;
  bool has_all;
  bool all_muted;
  bool has_synth;
  bool synth_muted;
  bool has_piano;
  bool piano_muted;
};
static PendingDisplay s_pending_disp{};
static volatile bool s_disp_pending = false;
static bool s_draw_song_busy = false;
static uint32_t s_last_song_ui_ms = 0;

static lv_obj_t *s_scr = nullptr;
static lv_obj_t *s_main = nullptr;
static lv_obj_t *s_brand = nullptr;
static lv_obj_t *s_ver_lbl = nullptr;
static lv_obj_t *s_transport_lbl = nullptr;
static lv_obj_t *s_clock_lbl = nullptr;
static lv_obj_t *s_set_progress_lbl = nullptr;
static lv_obj_t *s_text_box = nullptr;
static lv_obj_t *s_title_lbl = nullptr;
static lv_obj_t *s_next_lbl = nullptr;
static lv_obj_t *s_year_lbl = nullptr;
static lv_obj_t *s_duration_lbl = nullptr;
static lv_obj_t *s_position_lbl = nullptr;
static lv_obj_t *s_footer_lbl = nullptr;
static lv_obj_t *s_idle_lbl = nullptr;
static lv_obj_t *s_pad_btns[PAD_COUNT] = {nullptr};
static lv_obj_t *s_pad_status[PAD_COUNT] = {nullptr};

#if defined(VIEWERONE_ENABLE_LED)
static TaskHandle_t s_led_task = nullptr;
#endif

static String lineBuf;
static uint32_t s_last_pad_ms[PAD_COUNT] = {0};

static lv_color_t col_hex(uint32_t rgb) { return lv_color_hex(rgb); }

static void applyMainTheme(bool muted) {
  if (!s_main) return;
  const lv_color_t bg = muted ? col_hex(0x000088) : col_hex(0x050608);
  const lv_color_t fg = muted ? col_hex(0xFFE600) : col_hex(0x39FF14);
  /** Now-playing title — cyan (matches PC totals / preview), not theme lime/yellow. */
  const lv_color_t titleFg = col_hex(0x00E5FF);
  lv_obj_set_style_bg_color(s_main, bg, 0);
  if (s_title_lbl) lv_obj_set_style_text_color(s_title_lbl, titleFg, 0);
  if (s_next_lbl) lv_obj_set_style_text_color(s_next_lbl, fg, 0);
  if (s_year_lbl) lv_obj_set_style_text_color(s_year_lbl, fg, 0);
  if (s_duration_lbl) lv_obj_set_style_text_color(s_duration_lbl, fg, 0);
  if (s_position_lbl) lv_obj_set_style_text_color(s_position_lbl, fg, 0);
  if (s_footer_lbl) lv_obj_set_style_text_color(s_footer_lbl, fg, 0);
  if (s_idle_lbl) lv_obj_set_style_text_color(s_idle_lbl, col_hex(0xFFE600), 0);
  if (s_brand) {
    // Readable light grey on black (not #6B7280@70%); gold flash when FX-muted.
    lv_obj_set_style_text_color(s_brand, muted ? col_hex(0xC9B44A) : col_hex(0x9CA3AF), 0);
  }
  // Version stays light grey — not part of the mute theme flash.
  if (s_ver_lbl) {
    lv_obj_set_style_text_color(s_ver_lbl, col_hex(0xE5E7EB), 0);
    lv_obj_set_style_text_opa(s_ver_lbl, LV_OPA_COVER, 0);
  }
}

static void refreshPadVisual(int idx) {
  if (idx < 0 || idx >= PAD_COUNT || !s_pad_btns[idx]) return;
  const bool muted = s_pad_muted[idx];
  const bool channel_pad = idx == PAD_SYNTH || idx == PAD_PIANO;
  lv_color_t bg;
  lv_color_t border;
  lv_color_t fg;
  if (channel_pad) {
    // Filled green = live/unmuted; filled dark grey = muted/off.
    if (muted) {
      bg = col_hex(0x14171C);
      border = col_hex(0x2A303A);
      fg = col_hex(0x6B7280);
    } else {
      bg = col_hex(0x1B5E20);
      border = col_hex(0x2ECC71);
      fg = col_hex(0xE8FFE8);
    }
  } else if (idx == PAD_FX && muted) {
    bg = col_hex(0x000088);
    border = col_hex(0x2E8BFF);
    fg = col_hex(0xEAF4FF);
  } else if (muted) {
    bg = col_hex(0x5C1A1A);
    border = col_hex(0xFF6A00);
    fg = col_hex(0xFFCC66);
  } else {
    bg = col_hex(0x0F2A18);
    border = col_hex(0x2ECC71);
    fg = col_hex(0xB8F5C8);
  }
  // Instant mute colors (theme TRANSITION_TIME=0 / GROW=0). Same fill for PRESSED —
  // do NOT set style_transition(nullptr): LVGL can fault on press if that dsc is null.
  lv_obj_t *btn = s_pad_btns[idx];
  lv_obj_set_style_bg_color(btn, bg, 0);
  lv_obj_set_style_bg_color(btn, bg, LV_STATE_PRESSED);
  lv_obj_set_style_border_color(btn, border, 0);
  lv_obj_set_style_border_color(btn, border, LV_STATE_PRESSED);
  lv_obj_set_style_border_width(btn, 2, LV_STATE_PRESSED);
  lv_obj_set_style_text_color(btn, fg, 0);
  // Kill theme btn press recolor (darken filter) without touching transition pointers.
  lv_obj_set_style_color_filter_opa(btn, LV_OPA_TRANSP, 0);
  lv_obj_set_style_color_filter_opa(btn, LV_OPA_TRANSP, LV_STATE_PRESSED);
  lv_obj_set_style_outline_width(btn, 0, LV_STATE_PRESSED);
  lv_obj_set_style_outline_opa(btn, LV_OPA_TRANSP, LV_STATE_PRESSED);
  lv_obj_set_style_transform_width(btn, 0, LV_STATE_PRESSED);
  lv_obj_set_style_transform_height(btn, 0, LV_STATE_PRESSED);
  if (s_pad_status[idx]) {
    lv_label_set_text(s_pad_status[idx], muted ? "MUTED" : "LIVE");
    lv_obj_set_style_text_color(
        s_pad_status[idx],
        muted ? (channel_pad ? col_hex(0x6B7280)
                             : (idx == PAD_FX ? col_hex(0x9DCEFF) : col_hex(0xFF8A4C)))
              : (channel_pad ? col_hex(0xA7F3B0) : col_hex(0x5CDE8A)),
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
  if (s_duration_lbl) {
    if (waiting) {
      lv_obj_add_flag(s_duration_lbl, LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_clear_flag(s_duration_lbl, LV_OBJ_FLAG_HIDDEN);
    }
  }
  if (s_position_lbl) {
    if (waiting) {
      lv_obj_add_flag(s_position_lbl, LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_clear_flag(s_position_lbl, LV_OBJ_FLAG_HIDDEN);
    }
  }
  if (s_next_lbl) {
    if (waiting) {
      lv_obj_add_flag(s_next_lbl, LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_clear_flag(s_next_lbl, LV_OBJ_FLAG_HIDDEN);
    }
  }
}

static void formatMmSs(int32_t sec, char *buf, size_t n) {
  if (sec < 0) sec = 0;
  snprintf(buf, n, "%02d:%02d", (int)(sec / 60), (int)(sec % 60));
}

/**
 * Three fixed meta slots (logical/pre-zoom coords). Content length must never move neighbors:
 * year left, MM:SS in the middle slot, song position in the right slot.
 * Duration stays narrow so 1Hz LVGL invalidation remains LED-friendly.
 */
static int yearLabelLogicalW() { return 5 * 28; }       // "YYYY"
static int durationLabelLogicalW() { return 5 * 30; }  // "MM:SS"
static int positionLabelLogicalW() { return 7 * 28; }  // "01/24" / "IN/24"
static constexpr int kMetaSlotGap = 36;
static int yearLabelX() { return 0; }
static int durationLabelX() {
  return yearLabelLogicalW() * (int)kYearZoom / 256 + kMetaSlotGap;
}
static int positionLabelX() {
  return durationLabelX() + durationLabelLogicalW() * (int)kYearZoom / 256 + kMetaSlotGap;
}

/** Pin a meta label into its fixed slot (bottom of text box). Call at create time only. */
static void placeMetaLabel(lv_obj_t *lbl, int x, int logical_w, lv_text_align_t align) {
  if (!lbl) return;
  lv_obj_set_width(lbl, logical_w);
  lv_obj_set_style_text_align(lbl, align, 0);
  lv_obj_align(lbl, LV_ALIGN_BOTTOM_LEFT, x, 0);
}

/** Apply pending MM:SS only — never blocks waiting for LVGL (LEDs win). */
static void flushDurationLabelIfDirty() {
  if (!s_duration_dirty) return;
  if (!lvgl_port_lock(0)) return;
  s_duration_dirty = false;
  if (s_duration_lbl && !s_showing_waiting) {
    lv_label_set_text(s_duration_lbl, s_duration[0] ? s_duration : "");
  }
  lvgl_port_unlock();
}

/** Host wall clock — cheap label set; skip when HH:MM unchanged (LEDs stay smooth). */
static void applyHostClock(const char *hm) {
  if (!hm || !hm[0]) return;
  char buf[8];
  strncpy(buf, hm, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = '\0';
  if (strcmp(s_clock, buf) == 0) return;
  memcpy(s_clock, buf, sizeof(s_clock));
  if (!s_clock_lbl) return;
  if (lvgl_port_lock(20)) {
    lv_label_set_text(s_clock_lbl, s_clock);
    lvgl_port_unlock();
  }
}

/** Brand-bar PLAY/STOP (+ optional countdown ARM/CD). Caller holds LVGL lock when from draw path. */
static void refreshTransportLbl() {
  if (!s_transport_lbl) return;
  char buf[20];
  const char *base = s_transport_playing ? "PLAY" : "STOP";
  if (s_cd_remain_sec >= 0) {
    snprintf(buf, sizeof(buf), "%s · %s", base, s_cd_running ? "CD" : "ARM");
  } else {
    snprintf(buf, sizeof(buf), "%s", base);
  }
  lv_label_set_text(s_transport_lbl, buf);
  // Yellow-green PLAY; muted-but-readable STOP — full opacity on black (matches Esp32Preview).
  lv_obj_set_style_text_color(s_transport_lbl,
                              s_transport_playing ? col_hex(0xB8FF26) : col_hex(0x9CA3AF), 0);
  lv_obj_set_style_text_opa(s_transport_lbl, LV_OPA_COVER, 0);
  if (s_ver_lbl) {
    lv_obj_align_to(s_transport_lbl, s_ver_lbl, LV_ALIGN_OUT_LEFT_MID, -12, 0);
  }
}

/** Pad-column set progress under clock — CLIP, no wrap. Caller holds LVGL lock. */
static void refreshSetProgressLbl() {
  if (!s_set_progress_lbl) return;
  lv_label_set_text(s_set_progress_lbl, s_set_progress[0] ? s_set_progress : "");
}

static void stopLocalCountdown() {
  s_cd_running = false;
  s_cd_remain_sec = -1;
  s_cd_last_shown = -1;
  s_duration_dirty = false;
}

static void armLocalCountdown(int32_t remain_sec, bool running) {
  if (remain_sec < 0) remain_sec = 0;
  s_cd_remain_sec = remain_sec;
  s_cd_anchor_sec = remain_sec;
  s_cd_anchor_ms = millis();
  s_cd_last_shown = remain_sec;
  s_cd_running = running && remain_sec > 0;
  formatMmSs(remain_sec, s_duration, sizeof(s_duration));
  s_duration_dirty = false;  // drawSongUi / caller sets the label under an existing lock
}

/** Tick local MM:SS when host armed with p=true; only dirties a flag — no LVGL on this path. */
static void tickLocalCountdown() {
  if (!s_cd_running || s_cd_remain_sec < 0) return;
  const uint32_t elapsed_ms = millis() - s_cd_anchor_ms;
  int32_t shown = s_cd_anchor_sec - (int32_t)(elapsed_ms / 1000U);
  if (shown < 0) shown = 0;
  if (shown == s_cd_last_shown) return;
  s_cd_last_shown = shown;
  s_cd_remain_sec = shown;
  formatMmSs(shown, s_duration, sizeof(s_duration));
  s_duration_dirty = true;
  if (shown == 0) s_cd_running = false;
}

static void drawSongUi(const char *title, const char *year, const char *duration,
                       const char *position, const char *next, bool muted) {
  // Caller must hold LVGL lock. Guard re-entrancy (pad / duration flush must not nest).
  if (s_draw_song_busy) return;
  s_draw_song_busy = true;

  copyBounded(s_title, sizeof(s_title), (title && title[0]) ? title : "-", kTitleMaxChars);
  copyBounded(s_year_only, sizeof(s_year_only), year ? year : "", sizeof(s_year_only) - 1);
  copyBounded(s_duration, sizeof(s_duration), duration ? duration : "", sizeof(s_duration) - 1);
  copyBounded(s_position, sizeof(s_position), position ? position : "", sizeof(s_position) - 1);
  // Next title — update label only when the string actually changes (mute / PC chase / re-arm
  // must not invalidate this band; LONG_DOT redraws were overlapping title/duration).
  char nextIn[sizeof(s_next)];
  copyBounded(nextIn, sizeof(nextIn), next ? next : "", kNextTitleMaxChars);
  const bool nextChanged = strcmp(s_next, nextIn) != 0;
  if (nextChanged) {
    copyBounded(s_next, sizeof(s_next), nextIn, kNextTitleMaxChars);
  }
  s_duration_dirty = false;
  s_fx_muted = muted;
  s_pad_muted[PAD_FX] = muted;
  showWaitingUi(false);
  if (s_title_lbl) lv_label_set_text(s_title_lbl, s_title);
  // Text only — slot X/width stay fixed so year/countdown/position never shove each other.
  if (s_year_lbl) lv_label_set_text(s_year_lbl, s_year_only[0] ? s_year_only : "");
  if (s_duration_lbl) lv_label_set_text(s_duration_lbl, s_duration[0] ? s_duration : "");
  if (s_position_lbl) lv_label_set_text(s_position_lbl, s_position[0] ? s_position : "");
  // Next song — change-only; empty at last song (label stays reserved above meta).
  // nextBuf sized for "Next : " + kNextTitleMaxChars + NUL.
  if (s_next_lbl && nextChanged) {
    if (s_next[0]) {
      char nextBuf[8 + kNextTitleMaxChars];
      snprintf(nextBuf, sizeof(nextBuf), "Next : %s", s_next);
      lv_label_set_text(s_next_lbl, nextBuf);
    } else {
      lv_label_set_text(s_next_lbl, "");
    }
  }
  applyMainTheme(muted);
  refreshPadVisual(PAD_FX);
  refreshFooter();
  // Do NOT call lv_refr_now(): 180° software rotation would force full-frame rotate + vsync.
  s_draw_song_busy = false;
}

static void drawWaitingUi() {
  stopLocalCountdown();
  s_fx_muted = false;
  s_pad_muted[PAD_FX] = false;
  strncpy(s_title, "Waiting", sizeof(s_title) - 1);
  s_year_only[0] = '\0';
  s_duration[0] = '\0';
  s_position[0] = '\0';
  s_next[0] = '\0';
  s_set_progress[0] = '\0';
  if (s_next_lbl) lv_label_set_text(s_next_lbl, "");
  refreshSetProgressLbl();
  showWaitingUi(true);
  applyMainTheme(false);
  refreshPadVisual(PAD_FX);
  refreshTransportLbl();
  refreshFooter();
}

static void sendMuteEvent(const char *group, bool muted) {
  // One JSON line only. FX / ALL / Synth / Piano include absolute muted so the host SETs once
  // (local pad already flipped — host must not toggle again).
  // Bare mute_toggle remains CYD firmware; CrowPanel always includes group + muted.
  if (!group || !group[0]) {
    Serial.println("{\"evt\":\"mute_toggle\"}");
    return;
  }
  Serial.printf(
      "{\"evt\":\"mute_toggle\",\"group\":\"%s\",\"muted\":%s}\n", group, muted ? "true" : "false");
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

  // Paint then serial. Do NOT call lv_refr_now(): 180° software rotation would force
  // full-frame rotate_copy + vsync and delay the next touch read.
  if (idx == PAD_ALL) {
    s_pad_muted[PAD_ALL] = !s_pad_muted[PAD_ALL];
    refreshPadVisual(PAD_ALL);
    sendMuteEvent("all", s_pad_muted[PAD_ALL]);
    return;
  }
  if (idx == PAD_FX) {
    s_pad_muted[PAD_FX] = !s_pad_muted[PAD_FX];
    s_fx_muted = s_pad_muted[PAD_FX];
    applyMainTheme(s_fx_muted);
    refreshPadVisual(PAD_FX);
    sendMuteEvent("fx", s_fx_muted);
    return;
  }
  if (idx == PAD_SYNTH) {
    s_pad_muted[PAD_SYNTH] = !s_pad_muted[PAD_SYNTH];
    refreshPadVisual(PAD_SYNTH);
    sendMuteEvent("synth", s_pad_muted[PAD_SYNTH]);
    return;
  }
  if (idx == PAD_PIANO) {
    s_pad_muted[PAD_PIANO] = !s_pad_muted[PAD_PIANO];
    refreshPadVisual(PAD_PIANO);
    sendMuteEvent("piano", s_pad_muted[PAD_PIANO]);
    return;
  }
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
  lv_label_set_text(s_brand, "VIEWERONE");
  lv_obj_set_style_text_font(s_brand, &lv_font_montserrat_22, 0);
  lv_obj_set_style_text_letter_space(s_brand, 3, 0);
  lv_obj_align(s_brand, LV_ALIGN_TOP_LEFT, 0, 0);
  lv_obj_clear_flag(s_brand, LV_OBJ_FLAG_CLICKABLE);

  // Firmware version — subtle top-right of brand bar (clock lives on the pad column).
  s_ver_lbl = lv_label_create(s_main);
  {
    char vbuf[24];
    snprintf(vbuf, sizeof(vbuf), "v%s", VIEWERONE_FW_VERSION);
    lv_label_set_text(s_ver_lbl, vbuf);
  }
  lv_obj_set_style_text_font(s_ver_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(s_ver_lbl, col_hex(0xE5E7EB), 0);
  lv_obj_set_style_text_opa(s_ver_lbl, LV_OPA_COVER, 0);
  lv_obj_align(s_ver_lbl, LV_ALIGN_TOP_RIGHT, 0, 4);
  lv_obj_clear_flag(s_ver_lbl, LV_OBJ_FLAG_CLICKABLE);

  // Transport PLAY/STOP — left of version; yellow-green when playing, readable grey when stopped.
  s_transport_lbl = lv_label_create(s_main);
  lv_obj_set_style_text_font(s_transport_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_letter_space(s_transport_lbl, 1, 0);
  lv_obj_clear_flag(s_transport_lbl, LV_OBJ_FLAG_CLICKABLE);
  refreshTransportLbl();
  lv_obj_align_to(s_transport_lbl, s_ver_lbl, LV_ALIGN_OUT_LEFT_MID, -12, 0);

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

  // Next song — bottom-aligned above meta; hard CLIP (no DOTS/ellipsis), no wrap.
  s_next_lbl = lv_label_create(s_text_box);
  lv_label_set_long_mode(s_next_lbl, LV_LABEL_LONG_CLIP);
  lv_obj_set_width(s_next_lbl, textBoxLabelW(kNextZoom));
  lv_obj_set_height(s_next_lbl, 48);
  lv_obj_set_style_text_font(s_next_lbl, &lv_font_montserrat_48, 0);
  applyTextZoom(s_next_lbl, kNextZoom);
  lv_obj_set_style_text_align(s_next_lbl, LV_TEXT_ALIGN_LEFT, 0);
  lv_obj_align(s_next_lbl, LV_ALIGN_BOTTOM_LEFT, 0, -kNextAboveMeta);
  lv_obj_add_flag(s_next_lbl, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(s_next_lbl, LV_OBJ_FLAG_CLICKABLE);

  // Fixed-slot meta band: year | MM:SS | position — never one concatenated reflowing string.
  s_year_lbl = lv_label_create(s_text_box);
  lv_label_set_long_mode(s_year_lbl, LV_LABEL_LONG_CLIP);
  lv_obj_set_style_text_font(s_year_lbl, &lv_font_montserrat_48, 0);
  applyTextZoom(s_year_lbl, kYearZoom);
  placeMetaLabel(s_year_lbl, yearLabelX(), yearLabelLogicalW(), LV_TEXT_ALIGN_LEFT);
  lv_obj_add_flag(s_year_lbl, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(s_year_lbl, LV_OBJ_FLAG_CLICKABLE);

  // Narrow MM:SS label — 1Hz ticks must only invalidate this small region (not the whole stage).
  s_duration_lbl = lv_label_create(s_text_box);
  lv_label_set_long_mode(s_duration_lbl, LV_LABEL_LONG_CLIP);
  lv_obj_set_style_text_font(s_duration_lbl, &lv_font_montserrat_48, 0);
  applyTextZoom(s_duration_lbl, kYearZoom);
  placeMetaLabel(s_duration_lbl, durationLabelX(), durationLabelLogicalW(), LV_TEXT_ALIGN_CENTER);
  lv_obj_add_flag(s_duration_lbl, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(s_duration_lbl, LV_OBJ_FLAG_CLICKABLE);

  // Song position — song-change only (not 1Hz); separate label keeps countdown region small.
  s_position_lbl = lv_label_create(s_text_box);
  lv_label_set_long_mode(s_position_lbl, LV_LABEL_LONG_CLIP);
  lv_obj_set_style_text_font(s_position_lbl, &lv_font_montserrat_48, 0);
  applyTextZoom(s_position_lbl, kYearZoom);
  placeMetaLabel(s_position_lbl, positionLabelX(), positionLabelLogicalW(), LV_TEXT_ALIGN_LEFT);
  lv_obj_add_flag(s_position_lbl, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(s_position_lbl, LV_OBJ_FLAG_CLICKABLE);

  // Right pad column — clock on top, four mute pads (~20% shorter than prior 116px).
  lv_obj_t *col = lv_obj_create(s_scr);
  lv_obj_set_size(col, PAD_COL_W - 10, SCREEN_H - 16);
  lv_obj_set_pos(col, MAIN_W + 2, 8);
  lv_obj_set_style_bg_color(col, col_hex(0x0C0E14), 0);
  lv_obj_set_style_border_width(col, 1, 0);
  lv_obj_set_style_border_color(col, col_hex(0x222833), 0);
  lv_obj_set_style_radius(col, 18, 0);
  lv_obj_set_style_pad_all(col, 10, 0);
  // Tighter row gap so set-progress fits without shrinking pad height (keep item_h = 93).
  lv_obj_set_style_pad_row(col, 3, 0);
  lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(col, LV_FLEX_ALIGN_SPACE_EVENLY, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(col, LV_OBJ_FLAG_SCROLLABLE);

  // Host-synced wall clock + set progress — yellow HH:MM, compact `12/30 · 41m` under it.
  lv_obj_t *clock_wrap = lv_obj_create(col);
  lv_obj_set_width(clock_wrap, PAD_COL_W - 36);
  lv_obj_set_height(clock_wrap, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_opa(clock_wrap, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(clock_wrap, 0, 0);
  lv_obj_set_style_pad_all(clock_wrap, 0, 0);
  lv_obj_set_style_pad_row(clock_wrap, 2, 0);
  lv_obj_set_flex_flow(clock_wrap, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(clock_wrap, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_clear_flag(clock_wrap, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(clock_wrap, LV_OBJ_FLAG_CLICKABLE);

  s_clock_lbl = lv_label_create(clock_wrap);
  lv_label_set_text(s_clock_lbl, s_clock[0] ? s_clock : "--:--");
  lv_obj_set_style_text_font(s_clock_lbl, &lv_font_montserrat_48, 0);
  lv_obj_set_style_text_color(s_clock_lbl, col_hex(0xFFE600), 0);
  lv_obj_set_style_text_letter_space(s_clock_lbl, 2, 0);
  lv_obj_set_style_bg_color(s_clock_lbl, col_hex(0x000000), 0);
  lv_obj_set_style_bg_opa(s_clock_lbl, LV_OPA_COVER, 0);
  lv_obj_set_style_pad_ver(s_clock_lbl, 6, 0);
  lv_obj_set_style_pad_hor(s_clock_lbl, 10, 0);
  lv_obj_set_style_radius(s_clock_lbl, 8, 0);
  lv_obj_set_width(s_clock_lbl, PAD_COL_W - 36);
  lv_obj_set_style_text_align(s_clock_lbl, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_clear_flag(s_clock_lbl, LV_OBJ_FLAG_CLICKABLE);

  s_set_progress_lbl = lv_label_create(clock_wrap);
  lv_label_set_long_mode(s_set_progress_lbl, LV_LABEL_LONG_CLIP);
  lv_obj_set_width(s_set_progress_lbl, PAD_COL_W - 36);
  lv_label_set_text(s_set_progress_lbl, "");
  lv_obj_set_style_text_font(s_set_progress_lbl, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(s_set_progress_lbl, col_hex(0x9CA3AF), 0);
  lv_obj_set_style_text_align(s_set_progress_lbl, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_letter_space(s_set_progress_lbl, 1, 0);
  lv_obj_clear_flag(s_set_progress_lbl, LV_OBJ_FLAG_CLICKABLE);

  const int item_w = PAD_COL_W - 36;
  const int item_h = 93;  // prior pad height — set-progress fits via tighter pad_row, not smaller pads
  for (int i = 0; i < PAD_COUNT; i++) {
    // lv_btn (stable press/indev path). Animations killed via lv_conf GROW=0 /
    // TRANSITION_TIME=0 plus per-pad filter/outline/transform overrides below.
    s_pad_btns[i] = lv_btn_create(col);
    lv_obj_set_size(s_pad_btns[i], item_w, item_h);
    lv_obj_set_style_radius(s_pad_btns[i], 12, 0);
    lv_obj_set_style_border_width(s_pad_btns[i], 2, 0);
    lv_obj_set_style_pad_all(s_pad_btns[i], 8, 0);
    lv_obj_clear_flag(s_pad_btns[i], LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_shadow_width(s_pad_btns[i], 0, 0);
    lv_obj_set_style_shadow_opa(s_pad_btns[i], LV_OPA_TRANSP, 0);
    lv_obj_set_style_outline_width(s_pad_btns[i], 0, 0);
    lv_obj_set_style_outline_width(s_pad_btns[i], 0, LV_STATE_PRESSED);
    lv_obj_set_style_outline_opa(s_pad_btns[i], LV_OPA_TRANSP, 0);
    lv_obj_set_style_outline_opa(s_pad_btns[i], LV_OPA_TRANSP, LV_STATE_PRESSED);
    lv_obj_set_style_transform_width(s_pad_btns[i], 0, LV_STATE_PRESSED);
    lv_obj_set_style_transform_height(s_pad_btns[i], 0, LV_STATE_PRESSED);
    lv_obj_set_style_color_filter_opa(s_pad_btns[i], LV_OPA_TRANSP, 0);
    lv_obj_set_style_color_filter_opa(s_pad_btns[i], LV_OPA_TRANSP, LV_STATE_PRESSED);
    lv_obj_add_event_cb(s_pad_btns[i], pad_event_cb, LV_EVENT_PRESSED, (void *)(intptr_t)i);

    lv_obj_t *lbl = lv_label_create(s_pad_btns[i]);
    lv_label_set_text(lbl, kPadLabels[i]);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_28, 0);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, -10);
    lv_obj_clear_flag(lbl, LV_OBJ_FLAG_CLICKABLE);

    s_pad_status[i] = lv_label_create(s_pad_btns[i]);
    lv_obj_set_style_text_font(s_pad_status[i], &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_letter_space(s_pad_status[i], 2, 0);
    lv_obj_align(s_pad_status[i], LV_ALIGN_BOTTOM_MID, 0, -8);
    lv_obj_clear_flag(s_pad_status[i], LV_OBJ_FLAG_CLICKABLE);

    refreshPadVisual(i);
  }

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
  // Pads 3–4 are Cubase Synth/Piano mutes; prompt JSON is accepted for host compat only.
  const int prompt = doc["prompt"] | 0;
  if ((prompt != 1 && prompt != 2) || doc["on"].isNull()) {
    Serial.println("{\"evt\":\"prompt\",\"ok\":false,\"err\":\"prompt_needs_1_or_2_and_on\"}");
    return;
  }
  const bool on = doc["on"].as<bool>();
  Serial.printf("{\"evt\":\"prompt\",\"ok\":true,\"prompt\":%d,\"on\":%s,\"ui\":false}\n", prompt,
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

  // Lightweight clock-only line from host: {"hm":"14:05"} (alias clk).
  const char *hm_field = nullptr;
  if (!doc["hm"].isNull()) hm_field = doc["hm"] | "";
  else if (!doc["clk"].isNull()) hm_field = doc["clk"] | "";
  if (hm_field && hm_field[0]) applyHostClock(hm_field);
  if (doc["t"].isNull()) return;

  const char *t = doc["t"] | "";
  const char *c = doc["c"] | "";
  const char *d = doc["d"] | "";
  const char *n = doc["n"] | "";
  const char *x = doc["x"] | "";
  const char *g = doc["g"] | "";
  bool m = doc["m"] | false;
  const bool has_all = !doc["a"].isNull();
  const bool all_muted = doc["a"] | false;
  const bool has_synth = !doc["s"].isNull();
  const bool synth_muted = doc["s"] | false;
  const bool has_piano = !doc["i"].isNull();
  const bool piano_muted = doc["i"] | false;
  const bool has_r = !doc["r"].isNull();
  const bool has_tr = !doc["tr"].isNull();
  const bool transport_playing = has_tr ? (doc["tr"].as<int>() != 0) : s_transport_playing;

  const char *duration_for_ui = d;
  if (has_r) {
    const int32_t remain = doc["r"].as<int32_t>();
    const bool playing = doc["p"] | false;
    armLocalCountdown(remain, playing);
    duration_for_ui = s_duration;
  } else {
    // Legacy host / waiting / static length — no local tick.
    stopLocalCountdown();
  }

  // Queue only — never take the LVGL lock here. Rapid song JSON would otherwise
  // stack full-frame invalidates under 180° rotate and trip the task WDT (cyan reboot).
  copyBounded(s_pending_disp.title, sizeof(s_pending_disp.title), t, kTitleMaxChars);
  if (!s_pending_disp.title[0]) {
    copyBounded(s_pending_disp.title, sizeof(s_pending_disp.title), "-", 1);
  }
  copyBounded(s_pending_disp.year, sizeof(s_pending_disp.year), c, sizeof(s_pending_disp.year) - 1);
  copyBounded(s_pending_disp.duration, sizeof(s_pending_disp.duration), duration_for_ui,
              sizeof(s_pending_disp.duration) - 1);
  copyBounded(s_pending_disp.position, sizeof(s_pending_disp.position), n,
              sizeof(s_pending_disp.position) - 1);
  copyBounded(s_pending_disp.next, sizeof(s_pending_disp.next), x, kNextTitleMaxChars);
  copyBounded(s_pending_disp.set_progress, sizeof(s_pending_disp.set_progress), g,
              kSetProgressMaxChars);
  s_pending_disp.muted = m;
  s_pending_disp.has_transport = has_tr;
  s_pending_disp.transport_playing = transport_playing;
  s_pending_disp.has_all = has_all;
  s_pending_disp.all_muted = all_muted;
  s_pending_disp.has_synth = has_synth;
  s_pending_disp.synth_muted = synth_muted;
  s_pending_disp.has_piano = has_piano;
  s_pending_disp.piano_muted = piano_muted;
  s_disp_pending = true;
}

/** Apply latest queued song UI (latest wins). Short lock; leave pending if LVGL is busy. */
static void applyPendingDisplayIfAny() {
  if (!s_disp_pending) return;
  const uint32_t now = millis();
  if (s_last_song_ui_ms != 0 && (now - s_last_song_ui_ms) < SONG_UI_COALESCE_MS) return;
  if (!lvgl_port_lock(LVGL_SONG_LOCK_MS)) return;

  PendingDisplay snap = s_pending_disp;
  s_disp_pending = false;
  s_last_song_ui_ms = now;

  drawSongUi(snap.title, snap.year, snap.duration, snap.position, snap.next, snap.muted);
  copyBounded(s_set_progress, sizeof(s_set_progress), snap.set_progress, kSetProgressMaxChars);
  refreshSetProgressLbl();
  if (snap.has_transport) {
    s_transport_playing = snap.transport_playing;
  }
  refreshTransportLbl();
  if (snap.has_all) {
    s_pad_muted[PAD_ALL] = snap.all_muted;
    refreshPadVisual(PAD_ALL);
  }
  if (snap.has_synth) {
    s_pad_muted[PAD_SYNTH] = snap.synth_muted;
    refreshPadVisual(PAD_SYNTH);
  }
  if (snap.has_piano) {
    s_pad_muted[PAD_PIANO] = snap.piano_muted;
    refreshPadVisual(PAD_PIANO);
  }
  lvgl_port_unlock();
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

#if defined(VIEWERONE_ENABLE_LED)
/** High-priority LED pump — must not share a core with LVGL flush / avoid-tear waits. */
static void ledTask(void * /*arg*/) {
  for (;;) {
    patternsTick();
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}
#endif

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
  // LED refresh on the opposite core from LVGL so MIPI full-frame flushes cannot stall WS2812.
  {
    BaseType_t led_core = 0;
#if defined(ARDUINO_RUNNING_CORE)
    led_core = (ARDUINO_RUNNING_CORE == 0) ? 1 : 0;
#endif
    // Priority above LVGL_PORT_TASK_PRIORITY (2) so pattern frames win over display work.
    xTaskCreatePinnedToCore(ledTask, "led", 4096, nullptr, 5, &s_led_task, led_core);
  }
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

  int lines = 0;
  while (Serial.available() && lines < SERIAL_LINES_PER_LOOP) {
    char ch = static_cast<char>(Serial.read());
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (lineBuf.length() == 0) continue;
      handleSerialLine(lineBuf);
      lineBuf = "";
      lines++;
      esp_task_wdt_reset();
    } else if (lineBuf.length() < 480) {
      lineBuf += ch;
    } else {
      // Drop oversized line — never grow unbounded.
      lineBuf = "";
    }
  }

  // Coalesced song UI (latest pending) — never drawn from the serial parse path.
  applyPendingDisplayIfAny();

  // Math only — LVGL label set is deferred so a 1Hz tick never races FastLED.show.
  tickLocalCountdown();
  flushDurationLabelIfDirty();

#if defined(VIEWERONE_ENABLE_LED)
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
