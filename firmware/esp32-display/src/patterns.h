#pragma once

#include <FastLED.h>
#include "led_config.h"

const char *patternName(PatternId id);

/** Full TFT/UI label: "00 - Knight Rider" (title case). Wire JSON still uses patternName().
 *  Random (20) shows current child when space allows: "20 - Random › 05 - Starfield". */
void patternLabelDisplay(PatternId id, char *out, size_t n);

void patternsBegin(CRGB *leds, uint16_t count);
void patternsSet(PatternId id);
PatternId patternsCurrent();
void patternsSetBrightness(uint8_t brightness);
void patternsTick();
void patternsClear();

/** True once after random rotator advances — caller should refresh the TFT footer. */
bool patternsConsumeFooterDirty();
