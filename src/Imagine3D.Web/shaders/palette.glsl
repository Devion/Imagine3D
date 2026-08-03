#include "common.glsl"

// Palettes. The storyboard picks a named palette per video and the five uPal
// colours are filled in from it, so every effect in a run shares one colour world
// without any effect hard-coding colours.

// Iquilez cosine palette - cheap, smooth, and cycles beautifully.
vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(TAU * (c * t + d));
}

/// Sample the storyboard palette as a smooth 5-stop ramp.
vec3 pal(float t) {
  t = fract(t);
  float f = t * 4.0;
  int i = int(floor(f));
  float k = smoothstep(0.0, 1.0, fract(f));
  if (i == 0) return mix(uPal0, uPal1, k);
  if (i == 1) return mix(uPal1, uPal2, k);
  if (i == 2) return mix(uPal2, uPal3, k);
  return mix(uPal3, uPal4, k);
}

/// Same ramp but clamped rather than wrapped - for mapping height, depth or luma.
vec3 palClamp(float t) {
  t = clamp(t, 0.0, 0.9999);
  float f = t * 4.0;
  int i = int(floor(f));
  float k = smoothstep(0.0, 1.0, fract(f));
  if (i == 0) return mix(uPal0, uPal1, k);
  if (i == 1) return mix(uPal1, uPal2, k);
  if (i == 2) return mix(uPal2, uPal3, k);
  return mix(uPal3, uPal4, k);
}

/// Hard-stepped palette - the true Amiga copper-list look, no gradients.
vec3 palSteps(float t, float steps) {
  return palClamp(floor(fract(t) * steps) / max(1.0, steps - 1.0));
}
