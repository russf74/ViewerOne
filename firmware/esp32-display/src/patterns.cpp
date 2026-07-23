#include "patterns.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

namespace {

CRGB *g_leds = nullptr;
uint16_t g_count = 0;
PatternId g_pattern = DEFAULT_PATTERN;

uint32_t g_lastMs = 0;
uint16_t g_pos = 0;
uint16_t g_pos2 = 0;
int8_t g_dir = 1;
int8_t g_dir2 = -1;
uint8_t g_hue = 0;
uint16_t g_phase = 0;
uint8_t g_heat[NUM_LEDS];

// Meta-pattern 20: sequential rotate through concrete ids 1..19 every ~10s
static constexpr uint32_t kRandomRotateMs = 10000;
PatternId g_randomChild = PATTERN_AURORA;
uint32_t g_randomNextMs = 0;
bool g_footerDirty = false;

// Dual comet — up to 4 independent heads (mirrored via setMirrored)
static constexpr uint8_t kCometCount = 4;
uint16_t g_cPos[kCometCount];
int8_t g_cDir[kCometCount];
uint8_t g_cAcc[kCometCount];
uint8_t g_cSpd[kCometCount];
uint8_t g_cHueOff[kCometCount];
uint8_t g_cTail[kCometCount];

/** Logical half length — strip is two mirrored halves joined at the midpoint. */
inline uint16_t halfLen() {
  return g_count / 2;
}

/** Write color to half-A[i] and the mirrored LED on half-B. */
inline void setMirrored(uint16_t i, const CRGB &color) {
  const uint16_t h = halfLen();
  if (!g_leds || i >= h) return;
  g_leds[i] = color;
  g_leds[g_count - 1 - i] = color;
}

void fadeAll(uint8_t amount) {
  for (uint16_t i = 0; i < g_count; i++) {
    g_leds[i].nscale8(amount);
  }
}

// --- 0: Knight Rider — scanner bounces in one half, echoed on the other ----
void tickKnightRider(uint32_t now) {
  if (now - g_lastMs < 28) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(200);
  setMirrored(g_pos, CRGB(255, 0, 0));
  if (g_pos > 0) setMirrored(g_pos - 1, CRGB(120, 0, 0));
  if (g_pos > 1) setMirrored(g_pos - 2, CRGB(40, 0, 0));
  if (g_pos + 1 < h) setMirrored(g_pos + 1, CRGB(120, 0, 0));
  if (g_pos + 2 < h) setMirrored(g_pos + 2, CRGB(40, 0, 0));
  g_pos = (uint16_t)((int)g_pos + g_dir);
  if (g_pos == 0 || g_pos >= h - 1) {
    g_pos = g_pos >= h - 1 ? (uint16_t)(h - 1) : 0;
    g_dir = (int8_t)-g_dir;
  }
  FastLED.show();
}

// --- 1: Aurora — busy teal / green / violet sky curtains ------------------
void tickAurora(uint32_t now) {
  if (now - g_lastMs < 16) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;

  for (uint16_t i = 0; i < h; i++) {
    // Layered traveling curtains (busy, colorful — not a scanner)
    uint8_t a = sin8((uint8_t)(i * 5) + (uint8_t)g_phase);
    uint8_t b = sin8((uint8_t)(i * 9) - (uint8_t)(g_phase / 2) + g_hue);
    uint8_t c = cos8((uint8_t)(i * 3) + (uint8_t)(g_phase / 3));
    uint8_t mix = (uint8_t)((a / 2) + (b / 3) + (c / 6));

    // Hue wanders teal → green → violet with local ripples
    uint8_t hue = qadd8(96, scale8(mix, 90));          // ~96 teal … ~186 violet
    hue = qadd8(hue, scale8(sin8((uint8_t)(i * 2) + g_hue), 28));

    uint8_t sat = qadd8(180, scale8(qsub8(255, mix), 60));
    uint8_t val = qadd8(28, scale8(mix, 220));
    // Bright curtain crest
    if (mix > 200) {
      uint8_t crest = qsub8(mix, 200);
      sat = qsub8(sat, scale8(crest, 90));
      val = 255;
    }
    setMirrored(i, CHSV(hue, sat, val));
  }

  // Occasional bright sparkle “shots” along the curtains
  if (random8() < 40) {
    uint16_t i = random16(h);
    setMirrored(i, CRGB(180, 255, 220));
    if (i + 1 < h) setMirrored(i + 1, CHSV(160, 180, 200));
  }

  g_phase += 5;
  g_hue += 1;
  FastLED.show();
}

// --- 2: Dual comet — multiple smooth comets with long fading tails ---------
void drawCometTail(uint16_t pos, int8_t dir, uint8_t hue, uint8_t tailLen, uint16_t h) {
  setMirrored(pos, CHSV(hue, 255, 255));
  for (uint8_t t = 1; t <= tailLen; t++) {
    int16_t idx = (int16_t)pos - (int16_t)dir * (int16_t)t;
    if (idx < 0 || idx >= (int16_t)h) continue;
    // Smooth falloff — bright near head, soft far end (no strobing)
    uint8_t fall = (uint8_t)((uint16_t)t * 220 / (tailLen + 1));
    uint8_t bri = qsub8(255, fall);
    uint8_t sat = qsub8(255, (uint8_t)(t * 6));
    setMirrored((uint16_t)idx, CHSV(hue + (uint8_t)(t * 3), sat, bri));
  }
}

void tickDualComet(uint32_t now) {
  if (now - g_lastMs < 18) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  // Gentler fade so long tails linger smoothly
  fadeAll(212);

  for (uint8_t c = 0; c < kCometCount; c++) {
    uint8_t hue = g_hue + g_cHueOff[c];
    drawCometTail(g_cPos[c], g_cDir[c], hue, g_cTail[c], h);

    g_cAcc[c]++;
    if (g_cAcc[c] < g_cSpd[c]) continue;
    g_cAcc[c] = 0;

    int16_t next = (int16_t)g_cPos[c] + g_cDir[c];
    if (next <= 0 || next >= (int16_t)h - 1) {
      g_cDir[c] = (int8_t)-g_cDir[c];
      if (next <= 0) g_cPos[c] = 0;
      else g_cPos[c] = (uint16_t)(h - 1);
      // Slightly retune speed/tail on bounce for ongoing variety
      g_cSpd[c] = 1 + random8(0, 3);
      g_cTail[c] = 8 + random8(0, 7);
    } else {
      g_cPos[c] = (uint16_t)next;
    }
  }
  g_hue++;
  FastLED.show();
}

// --- 3: Ocean wave — deep blue with white foam crests ----------------------
void tickOcean(uint32_t now) {
  if (now - g_lastMs < 18) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  for (uint16_t i = 0; i < h; i++) {
    uint8_t v = sin8(i * 7 + g_phase);
    uint8_t foam = (v > 210) ? scale8(v - 210, 200) : 0;
    setMirrored(i, CRGB(foam / 3, foam / 2 + scale8(v, 40), qadd8(30, scale8(v, 200))));
  }
  g_phase += 4;
  FastLED.show();
}

// --- 4: Lava — red/orange/yellow molten waves (ocean-like continuous flow) --
void tickLava(uint32_t now) {
  if (now - g_lastMs < 18) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;

  // Layered sines = continuous magma swell (never settles static)
  for (uint16_t i = 0; i < h; i++) {
    uint8_t w1 = sin8((uint8_t)(i * 7) + (uint8_t)g_phase);
    uint8_t w2 = sin8((uint8_t)(i * 3) - (uint8_t)(g_phase / 2));
    uint8_t w3 = sin8((uint8_t)(i * 11) + (uint8_t)(g_phase / 3));
    uint8_t wave = (uint8_t)((w1 / 2) + (w2 / 3) + (w3 / 6));

    // Cool troughs = deep crimson; crests = orange → yellow-white
    uint8_t hue = scale8(wave, 40);  // 0 red → ~40 yellow
    hue = qadd8(hue, scale8(sin8((uint8_t)(g_phase / 4) + (uint8_t)i), 6));

    uint8_t sat = 255;
    uint8_t val = qadd8(45, scale8(wave, 210));
    // Hot crest highlight (magma "foam") — desaturate toward yellow-white
    if (wave > 210) {
      uint8_t crest = qsub8(wave, 210);
      sat = qsub8(255, scale8(crest, 140));
      val = 255;
      hue = qadd8(hue, scale8(crest, 12));
    }

    setMirrored(i, CHSV(hue, sat, val));
  }
  g_phase += 4;
  FastLED.show();
}

// --- 5: Starfield — deep navy wash + soft white sparkles -------------------
void tickStarfield(uint32_t now) {
  if (now - g_lastMs < 22) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;

  // Stronger navy / deep-blue wash — brightness nearer cyber_rain green mid (≈120)
  for (uint16_t i = 0; i < h; i++) {
    uint8_t a = sin8((uint8_t)(i * 5) + (uint8_t)g_phase);
    uint8_t b = sin8((uint8_t)(i * 3) - (uint8_t)(g_phase / 2));
    uint8_t c = cos8((uint8_t)(i * 2) + (uint8_t)(g_phase / 3));
    uint8_t wave = (uint8_t)((a / 3) + (b / 3) + (c / 3));
    uint8_t hue = qadd8(148, scale8(sin8((uint8_t)(i * 2) + (uint8_t)(g_phase / 4)), 18));
    uint8_t sat = qadd8(220, scale8(qsub8(255, wave), 30));
    // Base ~40 (cyber_rain tail green), peaks ~160–180 (above cyber_rain mid 120)
    uint8_t val = qadd8(40, scale8(wave, 145));
    setMirrored(i, CHSV(hue, sat, val));
  }

  // Deterministic white twinkles — sparse sites, smooth sine peaks (no strobe)
  for (uint16_t i = 0; i < h; i++) {
    uint8_t hash = (uint8_t)(i * 73u + 29u);
    if ((hash % 7) != 0) continue;
    uint8_t tw = sin8((uint8_t)(g_phase * 2) + hash);
    uint8_t tw2 = sin8((uint8_t)g_phase + (uint8_t)(hash * 3));
    uint8_t peak = scale8(tw, tw2);
    if (peak < 185) continue;
    uint8_t bri = qadd8(40, scale8(qsub8(peak, 185), 255));
    setMirrored(i, CRGB(bri, bri, qadd8(bri, 8)));
  }

  // Occasional brighter sparkle with a soft blue-white neighbor (cyber-rain hint)
  if (random8() < 28) {
    uint16_t i = random16(h);
    setMirrored(i, CRGB(255, 255, 255));
    if (i > 0) setMirrored(i - 1, CRGB(90, 120, 180));
  }

  g_phase += 2;
  FastLED.show();
}

// --- 6: Cyber rain — Matrix-style green code rain --------------------------
void tickCyberRain(uint32_t now) {
  if (now - g_lastMs < 24) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(235);
  for (uint8_t n = 0; n < 3; n++) {
    if (random8() < 100) {
      uint16_t i = random16(h);
      setMirrored(i, CRGB(40, 255, 40));
      if (i > 0) setMirrored(i - 1, CRGB(0, 120, 0));
      if (i > 1) setMirrored(i - 2, CRGB(0, 40, 0));
    }
  }
  FastLED.show();
}

// --- 7: Rainbow ripple — expanding hue rings from a moving origin ----------
void tickRainbowRipple(uint32_t now) {
  if (now - g_lastMs < 16) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  uint16_t origin = scale16by8(h, sin8(g_phase));
  for (uint16_t i = 0; i < h; i++) {
    uint16_t dist = (i > origin) ? (i - origin) : (origin - i);
    setMirrored(i, CHSV((uint8_t)(g_hue + dist * 4), 255, 255));
  }
  g_phase += 2;
  g_hue++;
  FastLED.show();
}

// --- 8: Neon pulse — smooth breathe + soft traveling highlight -------------
void tickNeonPulse(uint32_t now) {
  if (now - g_lastMs < 16) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  // Continuous sine breathe (no sharp thumps)
  uint8_t breath = sin8(g_phase);
  uint8_t baseBri = qadd8(28, scale8(breath, 180));
  // Soft neon magenta ↔ cyan drift
  uint8_t hue = qadd8(192, scale8(sin8(g_phase / 2), 64));
  uint16_t tip = scale16by8(h, sin8(g_phase * 2));
  for (uint16_t i = 0; i < h; i++) {
    uint16_t dist = (i > tip) ? (i - tip) : (tip - i);
    uint8_t boost = (dist < 6) ? (uint8_t)(220 - dist * 30) : 0;
    uint8_t val = qadd8(baseBri, scale8(boost, 80));
    uint8_t sat = dist < 3 ? 180 : 255;
    setMirrored(i, CHSV(hue + (uint8_t)(dist), sat, val));
  }
  g_phase += 2;
  FastLED.show();
}

// --- 9: Galaxy spiral — rotating starfield ---------------------------------
void tickGalaxy(uint32_t now) {
  if (now - g_lastMs < 18) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  for (uint16_t i = 0; i < h; i++) {
    uint8_t spiral = sin8(i * 5 + g_phase) / 2 + cos8(i * 3 - g_phase) / 2;
    uint8_t hue = g_hue + spiral / 2 + i;
    uint8_t val = qadd8(20, spiral);
    setMirrored(i, CHSV(hue, 180, val));
  }
  if (random8() < 40 && h > 0) {
    setMirrored(random16(h), CRGB::White);
  }
  g_phase += 4;
  g_hue++;
  FastLED.show();
}

// --- 10: Strobe wave — smooth traveling brightness bands (not harsh flash) --
void tickStrobeWave(uint32_t now) {
  if (now - g_lastMs < 14) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  for (uint16_t i = 0; i < h; i++) {
    uint8_t a = sin8((uint8_t)(i * 9) + (uint8_t)g_phase);
    uint8_t b = sin8((uint8_t)(i * 5) - (uint8_t)(g_phase * 2));
    uint8_t band = scale8(a, b);
    // Soft peaks — dense motion, no full-strip white blast
    uint8_t val = qadd8(18, scale8(band, 230));
    uint8_t hue = g_hue + (uint8_t)(i * 3) + scale8(a, 40);
    uint8_t sat = band > 200 ? 160 : 255;
    setMirrored(i, CHSV(hue, sat, val));
  }
  g_phase += 7;
  g_hue += 2;
  FastLED.show();
}

// --- 11: Disco ball — rotating specular facets -----------------------------
void tickDiscoBall(uint32_t now) {
  if (now - g_lastMs < 36) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(220);
  // Dim purple floor so facets pop
  for (uint16_t i = 0; i < h; i++) {
    uint8_t floor = scale8(sin8((uint8_t)(i * 2) + (uint8_t)g_phase), 50);
    setMirrored(i, CHSV(200, 180, qadd8(10, floor)));
  }
  // Many bright rotating "mirrors" (slower phase advance)
  for (uint8_t n = 0; n < 10; n++) {
    uint16_t pos = (uint16_t)(((uint32_t)g_phase * (2 + (n % 3)) + n * 37) % h);
    uint8_t hue = g_hue + n * 28;
    setMirrored(pos, CHSV(hue, 200, 255));
    if (pos > 0) setMirrored(pos - 1, CHSV(hue, 255, 140));
    if (pos + 1 < h) setMirrored(pos + 1, CHSV(hue + 8, 255, 140));
  }
  g_phase += 1;
  g_hue += 1;
  FastLED.show();
}

// --- 12: Laser sweep — multi-beam colored lasers with soft trails ----------
void tickLaserSweep(uint32_t now) {
  if (now - g_lastMs < 12) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(190);
  for (uint8_t c = 0; c < kCometCount; c++) {
    uint8_t hue = g_hue + g_cHueOff[c];
    setMirrored(g_cPos[c], CHSV(hue, 255, 255));
    // Soft trail behind beam
    for (uint8_t t = 1; t <= 5; t++) {
      int16_t idx = (int16_t)g_cPos[c] - (int16_t)g_cDir[c] * (int16_t)t;
      if (idx < 0 || idx >= (int16_t)h) continue;
      setMirrored((uint16_t)idx, CHSV(hue, 255, (uint8_t)(220 - t * 40)));
    }
    g_cAcc[c]++;
    if (g_cAcc[c] < g_cSpd[c]) continue;
    g_cAcc[c] = 0;
    int16_t next = (int16_t)g_cPos[c] + g_cDir[c] * (1 + (c & 1));
    if (next <= 0 || next >= (int16_t)h - 1) {
      g_cDir[c] = (int8_t)-g_cDir[c];
      g_cPos[c] = next <= 0 ? 0 : (uint16_t)(h - 1);
    } else {
      g_cPos[c] = (uint16_t)next;
    }
  }
  g_hue += 3;
  FastLED.show();
}

// --- 13: Bass pulse — deep violet/magenta pressure rollers (no flood thump) -
void tickBassPulse(uint32_t now) {
  if (now - g_lastMs < 16) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;

  // Layered traveling rollers — busy continuous motion like lava / aurora
  for (uint16_t i = 0; i < h; i++) {
    uint8_t a = sin8((uint8_t)(i * 6) + (uint8_t)g_phase);
    uint8_t b = sin8((uint8_t)(i * 11) - (uint8_t)(g_phase / 2) + g_hue);
    uint8_t c = cos8((uint8_t)(i * 4) + (uint8_t)(g_phase / 3));
    uint8_t wave = (uint8_t)((a / 2) + (b / 3) + (c / 6));

    // Club palette: deep violet → magenta → hot pink (hue ~160–230)
    uint8_t hue = qadd8(160, scale8(wave, 70));
    hue = qadd8(hue, scale8(sin8((uint8_t)(i * 2) + g_hue), 20));

    uint8_t sat = qadd8(200, scale8(qsub8(255, wave), 50));
    uint8_t val = qadd8(32, scale8(wave, 210));
    // Soft ridge crest (pressure peak) — not a whole-strip flash
    if (wave > 205) {
      uint8_t crest = qsub8(wave, 205);
      sat = qsub8(sat, scale8(crest, 80));
      val = 255;
      hue = qadd8(hue, scale8(crest, 10));
    }
    setMirrored(i, CHSV(hue, sat, val));
  }

  // Occasional violet spark accents along the rollers
  if (random8() < 32) {
    uint16_t i = random16(h);
    setMirrored(i, CRGB(160, 40, 255));
    if (i + 1 < h) setMirrored(i + 1, CHSV(200, 200, 180));
  }

  g_phase += 5;
  g_hue += 1;
  FastLED.show();
}

// --- 14: Confetti storm — dense soft multicolor particle rain --------------
void tickConfettiStorm(uint32_t now) {
  if (now - g_lastMs < 12) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(220);
  // Many soft flakes — busy but no full-strip flash
  uint8_t flakes = 6 + (g_phase & 7);
  for (uint8_t n = 0; n < flakes; n++) {
    uint16_t i = random16(h);
    uint8_t hue = g_hue + random8(90);
    setMirrored(i, CHSV(hue, 200, 255));
    if (i > 0 && random8() < 120) setMirrored(i - 1, CHSV(hue + 10, 255, 120));
  }
  g_hue += 3;
  g_phase++;
  FastLED.show();
}

// --- 15: Hyper chase — fast multi-head rainbow chase -----------------------
void tickHyperChase(uint32_t now) {
  if (now - g_lastMs < 10) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(180);
  for (uint8_t c = 0; c < kCometCount; c++) {
    uint8_t hue = g_hue + g_cHueOff[c];
    drawCometTail(g_cPos[c], g_cDir[c], hue, 6, h);
    // Always advance fast
    int16_t next = (int16_t)g_cPos[c] + g_cDir[c] * 2;
    if (next <= 0 || next >= (int16_t)h - 1) {
      g_cDir[c] = (int8_t)-g_cDir[c];
      g_cPos[c] = next <= 0 ? 0 : (uint16_t)(h - 1);
    } else {
      g_cPos[c] = (uint16_t)next;
    }
  }
  g_hue += 4;
  FastLED.show();
}

// --- 16: Prism spin — rotating soft color wedges ---------------------------
void tickPrismSpin(uint32_t now) {
  // Faster frame + larger phase step = clearly spinning; soft blends keep it non-stroby
  if (now - g_lastMs < 22) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  const uint8_t wedges = 6;
  for (uint16_t i = 0; i < h; i++) {
    uint16_t scaled = (uint16_t)(i * wedges) + (g_phase / 2);
    uint8_t slot = (uint8_t)((scaled / h) % wedges);
    uint16_t within = scaled % h;
    uint8_t hue = g_hue + slot * 42;
    uint8_t nextHue = g_hue + (uint8_t)((slot + 1) % wedges) * 42;
    // Blend across ~1/4 of each wedge near the boundary (soft edges)
    uint16_t blendZone = h / 4;
    if (blendZone < 3) blendZone = 3;
    uint8_t val = 220;
    if (within + blendZone >= h) {
      uint8_t t = (uint8_t)(((within + blendZone - h) * 255) / blendZone);
      hue = lerp8by8(hue, nextHue, t);
      val = qsub8(220, scale8(t, 30));  // slight dip, not a bright flash
    }
    setMirrored(i, CHSV(hue, 230, val));
  }
  g_phase += 4;
  g_hue++;
  FastLED.show();
}

// --- 17: Spark shower — dense sparks across the full logical half -----------
void tickSparkShower(uint32_t now) {
  if (now - g_lastMs < 16) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;

  // Cool and soft fall (toward high indices = "down") — lighter so sparks
  // remain visible across the whole half, not just a thin band.
  for (uint16_t i = 0; i < h; i++) {
    g_heat[i] = qsub8(g_heat[i], random8(6, 20));
  }
  for (int k = (int)h - 1; k >= 1; k--) {
    g_heat[k] = qadd8(g_heat[k], scale8(g_heat[k - 1], 110));
    g_heat[k - 1] = scale8(g_heat[k - 1], 75);
  }
  // Dense sparks across the FULL logical half (mirroring fills both halves)
  uint8_t sparks = (uint8_t)(h / 6);
  if (sparks < 10) sparks = 10;
  if (sparks > 28) sparks = 28;
  for (uint8_t n = 0; n < sparks; n++) {
    if (random8() < 220) {
      uint16_t i = random16(h);
      g_heat[i] = 255;
      if (i > 0 && random8() < 100) g_heat[i - 1] = qadd8(g_heat[i - 1], 160);
      if (i + 1 < h && random8() < 100) g_heat[i + 1] = qadd8(g_heat[i + 1], 160);
    }
  }
  for (uint16_t j = 0; j < h; j++) {
    uint8_t heat = g_heat[j];
    if (heat < 20) {
      setMirrored(j, CRGB::Black);
      continue;
    }
    uint8_t hue = g_hue + scale8(heat, 60);
    uint8_t sat = heat > 220 ? 120 : 255;
    setMirrored(j, CHSV(hue, sat, heat));
  }
  g_hue += 2;
  FastLED.show();
}

// --- 18: Color bomb — expanding hue blast rings from moving centers --------
void tickColorBomb(uint32_t now) {
  if (now - g_lastMs < 14) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(200);

  // Two concurrent expanding rings (reuse pos / pos2 as centers)
  uint16_t radius = (uint16_t)(g_phase % (h + 12));
  uint16_t radius2 = (uint16_t)((g_phase * 3 / 2) % (h + 12));
  for (uint16_t i = 0; i < h; i++) {
    uint16_t d1 = (i > g_pos) ? (i - g_pos) : (g_pos - i);
    uint16_t d2 = (i > g_pos2) ? (i - g_pos2) : (g_pos2 - i);
    uint8_t ring = 0;
    uint8_t hue = g_hue;
    if (d1 <= radius && radius - d1 < 5) {
      ring = (uint8_t)(255 - (radius - d1) * 45);
      hue = g_hue;
    }
    if (d2 <= radius2 && radius2 - d2 < 5) {
      uint8_t r2 = (uint8_t)(255 - (radius2 - d2) * 45);
      if (r2 > ring) {
        ring = r2;
        hue = g_hue + 96;
      }
    }
    if (ring > 0) setMirrored(i, CHSV(hue + (uint8_t)i, 255, ring));
  }
  // Relocate blast centers when a ring finishes
  if (radius == 0) {
    g_pos = random16(h);
    g_hue += 37;
  }
  if (radius2 == 0) {
    g_pos2 = random16(h);
  }
  g_phase++;
  FastLED.show();
}

// --- 19: Roller derby — racing packs bouncing on the half-strip ------------
void tickRollerDerby(uint32_t now) {
  if (now - g_lastMs < 12) return;
  g_lastMs = now;
  const uint16_t h = halfLen();
  if (h == 0) return;
  fadeAll(195);

  for (uint8_t c = 0; c < kCometCount; c++) {
    uint8_t hue = g_hue + g_cHueOff[c];
    // Pack body (3 LEDs)
    setMirrored(g_cPos[c], CHSV(hue, 255, 255));
    if (g_cPos[c] > 0) setMirrored(g_cPos[c] - 1, CHSV(hue + 8, 255, 200));
    if (g_cPos[c] + 1 < h) setMirrored(g_cPos[c] + 1, CHSV(hue - 8, 200, 200));

    g_cAcc[c]++;
    uint8_t stepEvery = g_cSpd[c] == 0 ? 1 : g_cSpd[c];
    if (g_cAcc[c] < stepEvery) continue;
    g_cAcc[c] = 0;

    int16_t next = (int16_t)g_cPos[c] + g_cDir[c] * (int16_t)(1 + (c % 3));
    if (next <= 0 || next >= (int16_t)h - 1) {
      g_cDir[c] = (int8_t)-g_cDir[c];
      g_cPos[c] = next <= 0 ? 0 : (uint16_t)(h - 1);
      g_cSpd[c] = 1 + random8(0, 2);
      g_cHueOff[c] += 20;
    } else {
      g_cPos[c] = (uint16_t)next;
    }
  }
  g_hue += 2;
  FastLED.show();
}

}  // namespace

const char *patternName(PatternId id) {
  switch (id) {
    case PATTERN_KNIGHT_RIDER: return "knight_rider";
    case PATTERN_AURORA: return "aurora";
    case PATTERN_DUAL_COMET: return "dual_comet";
    case PATTERN_OCEAN: return "ocean";
    case PATTERN_LAVA: return "lava";
    case PATTERN_STARFIELD: return "starfield";
    case PATTERN_CYBER_RAIN: return "cyber_rain";
    case PATTERN_RAINBOW_RIPPLE: return "rainbow_ripple";
    case PATTERN_NEON_PULSE: return "neon_pulse";
    case PATTERN_GALAXY: return "galaxy";
    case PATTERN_STROBE_WAVE: return "strobe_wave";
    case PATTERN_DISCO_BALL: return "disco_ball";
    case PATTERN_LASER_SWEEP: return "laser_sweep";
    case PATTERN_BASS_PULSE: return "bass_pulse";
    case PATTERN_CONFETTI_STORM: return "confetti_storm";
    case PATTERN_HYPER_CHASE: return "hyper_chase";
    case PATTERN_PRISM_SPIN: return "prism_spin";
    case PATTERN_SPARK_SHOWER: return "spark_shower";
    case PATTERN_COLOR_BOMB: return "color_bomb";
    case PATTERN_ROLLER_DERBY: return "roller_derby";
    case PATTERN_RANDOM: return "random";
    case PATTERN_OFF: return "off";
    default: return "unknown";
  }
}

static const char *patternTitle(PatternId id) {
  switch (id) {
    case PATTERN_KNIGHT_RIDER: return "Knight Rider";
    case PATTERN_AURORA: return "Aurora";
    case PATTERN_DUAL_COMET: return "Dual Comet";
    case PATTERN_OCEAN: return "Ocean";
    case PATTERN_LAVA: return "Lava";
    case PATTERN_STARFIELD: return "Starfield";
    case PATTERN_CYBER_RAIN: return "Cyber Rain";
    case PATTERN_RAINBOW_RIPPLE: return "Rainbow Ripple";
    case PATTERN_NEON_PULSE: return "Neon Pulse";
    case PATTERN_GALAXY: return "Galaxy";
    case PATTERN_STROBE_WAVE: return "Strobe Wave";
    case PATTERN_DISCO_BALL: return "Disco Ball";
    case PATTERN_LASER_SWEEP: return "Laser Sweep";
    case PATTERN_BASS_PULSE: return "Bass Pulse";
    case PATTERN_CONFETTI_STORM: return "Confetti Storm";
    case PATTERN_HYPER_CHASE: return "Hyper Chase";
    case PATTERN_PRISM_SPIN: return "Prism Spin";
    case PATTERN_SPARK_SHOWER: return "Spark Shower";
    case PATTERN_COLOR_BOMB: return "Color Bomb";
    case PATTERN_ROLLER_DERBY: return "Roller Derby";
    case PATTERN_RANDOM: return "Random";
    case PATTERN_OFF: return "Off";
    default: return "Unknown";
  }
}

void patternLabelDisplay(PatternId id, char *out, size_t n) {
  if (!out || n == 0) return;
  if (id == PATTERN_OFF) {
    snprintf(out, n, "Off");
    return;
  }
  if (id == PATTERN_RANDOM) {
    // e.g. "20 - Random › 05 - Starfield" (size-1 footer if long)
    snprintf(out, n, "%02u - %s › %02u - %s", (unsigned)PATTERN_RANDOM, "Random",
             (unsigned)g_randomChild, patternTitle(g_randomChild));
    return;
  }
  if (id >= PATTERN_COUNT) {
    snprintf(out, n, "?? - Unknown");
    return;
  }
  snprintf(out, n, "%02u - %s", (unsigned)id, patternTitle(id));
}

void patternsBegin(CRGB *leds, uint16_t count) {
  g_leds = leds;
  g_count = count > NUM_LEDS ? NUM_LEDS : count;
  memset(g_heat, 0, sizeof(g_heat));
  patternsSet(DEFAULT_PATTERN);
}

void patternsClear() {
  if (!g_leds) return;
  fill_solid(g_leds, g_count, CRGB::Black);
  FastLED.show();
}

void patternsSet(PatternId id) {
  g_pattern = id;
  g_pos = 0;
  g_pos2 = halfLen() > 0 ? (uint16_t)(halfLen() - 1) : 0;
  g_dir = 1;
  g_dir2 = -1;
  g_hue = 0;
  g_phase = 0;
  g_lastMs = 0;
  memset(g_heat, 0, sizeof(g_heat));

  if (id == PATTERN_RANDOM) {
    g_randomChild = PATTERN_AURORA;
    g_randomNextMs = millis() + kRandomRotateMs;
  }

  const uint16_t h = halfLen();
  // Staggered comets: positions, opposing dirs, varied speeds & long tails
  static const uint8_t kHueOff[kCometCount] = {0, 64, 128, 192};
  static const uint8_t kSpd[kCometCount] = {1, 2, 1, 3};
  static const uint8_t kTail[kCometCount] = {12, 9, 14, 10};
  for (uint8_t c = 0; c < kCometCount; c++) {
    g_cPos[c] = h > 1 ? (uint16_t)((h - 1) * c / (kCometCount - 1)) : 0;
    g_cDir[c] = (c & 1) ? (int8_t)-1 : (int8_t)1;
    g_cAcc[c] = 0;
    g_cSpd[c] = kSpd[c];
    g_cHueOff[c] = kHueOff[c];
    g_cTail[c] = kTail[c];
  }
  // Keep legacy pos in sync with first two comets
  g_pos = g_cPos[0];
  g_pos2 = g_cPos[1];
  g_dir = g_cDir[0];
  g_dir2 = g_cDir[1];

  patternsClear();
  if (id == PATTERN_OFF) return;
}

PatternId patternsCurrent() { return g_pattern; }

bool patternsConsumeFooterDirty() {
  if (!g_footerDirty) return false;
  g_footerDirty = false;
  return true;
}

void patternsSetBrightness(uint8_t brightness) {
  FastLED.setBrightness(brightness);
  FastLED.show();
}

/** Reset animation state without changing g_pattern / random rotator schedule. */
static void resetAnimState() {
  g_pos = 0;
  g_pos2 = halfLen() > 0 ? (uint16_t)(halfLen() - 1) : 0;
  g_dir = 1;
  g_dir2 = -1;
  g_hue = 0;
  g_phase = 0;
  g_lastMs = 0;
  memset(g_heat, 0, sizeof(g_heat));
  const uint16_t h = halfLen();
  static const uint8_t kHueOff[kCometCount] = {0, 64, 128, 192};
  static const uint8_t kSpd[kCometCount] = {1, 2, 1, 3};
  static const uint8_t kTail[kCometCount] = {12, 9, 14, 10};
  for (uint8_t c = 0; c < kCometCount; c++) {
    g_cPos[c] = h > 1 ? (uint16_t)((h - 1) * c / (kCometCount - 1)) : 0;
    g_cDir[c] = (c & 1) ? (int8_t)-1 : (int8_t)1;
    g_cAcc[c] = 0;
    g_cSpd[c] = kSpd[c];
    g_cHueOff[c] = kHueOff[c];
    g_cTail[c] = kTail[c];
  }
  g_pos = g_cPos[0];
  g_pos2 = g_cPos[1];
  g_dir = g_cDir[0];
  g_dir2 = g_cDir[1];
}

void patternsTick() {
  if (!g_leds || g_pattern == PATTERN_OFF) return;
  const uint32_t now = millis();

  PatternId run = g_pattern;
  if (g_pattern == PATTERN_RANDOM) {
    if ((int32_t)(now - g_randomNextMs) >= 0) {
      uint8_t next = (uint8_t)g_randomChild + 1;
      if (next > (uint8_t)PATTERN_ROLLER_DERBY) next = (uint8_t)PATTERN_AURORA;
      g_randomChild = (PatternId)next;
      g_randomNextMs = now + kRandomRotateMs;
      resetAnimState();
      patternsClear();
      g_footerDirty = true;
    }
    run = g_randomChild;
  }

  switch (run) {
    case PATTERN_KNIGHT_RIDER: tickKnightRider(now); break;
    case PATTERN_AURORA: tickAurora(now); break;
    case PATTERN_DUAL_COMET: tickDualComet(now); break;
    case PATTERN_OCEAN: tickOcean(now); break;
    case PATTERN_LAVA: tickLava(now); break;
    case PATTERN_STARFIELD: tickStarfield(now); break;
    case PATTERN_CYBER_RAIN: tickCyberRain(now); break;
    case PATTERN_RAINBOW_RIPPLE: tickRainbowRipple(now); break;
    case PATTERN_NEON_PULSE: tickNeonPulse(now); break;
    case PATTERN_GALAXY: tickGalaxy(now); break;
    case PATTERN_STROBE_WAVE: tickStrobeWave(now); break;
    case PATTERN_DISCO_BALL: tickDiscoBall(now); break;
    case PATTERN_LASER_SWEEP: tickLaserSweep(now); break;
    case PATTERN_BASS_PULSE: tickBassPulse(now); break;
    case PATTERN_CONFETTI_STORM: tickConfettiStorm(now); break;
    case PATTERN_HYPER_CHASE: tickHyperChase(now); break;
    case PATTERN_PRISM_SPIN: tickPrismSpin(now); break;
    case PATTERN_SPARK_SHOWER: tickSparkShower(now); break;
    case PATTERN_COLOR_BOMB: tickColorBomb(now); break;
    case PATTERN_ROLLER_DERBY: tickRollerDerby(now); break;
    default: break;
  }
}
