#include "common.glsl"
#include "palette.glsl"

// A nebula from an inversion fractal.
//
// The field is not a distance function and nothing is marched. p is repeatedly
// inverted through the unit sphere and offset, and what gets accumulated is a
// narrow Gaussian on how much the orbit's *magnitude changed* at each fold. Where
// consecutive folds land at nearly the same radius the term spikes; elsewhere it
// is nothing. Summing those spikes with a decaying weight is what piles up into
// filaments and voids - it is a density, arrived at without any volume at all.
//
// The reference shader read its four drive values from an FFT texture, which is
// exactly what this project already has as uniforms, so the spectrum drives it
// directly rather than through a texture bound to the audio.
//
// Technique reference: the "Star Nursery" family of Shadertoys.

float field(vec3 p, float s, int iters) {
  // The tiny time-dependent wobble on `strength` keeps the filaments from ever
  // settling into a fixed pattern.
  float strength = 7.0 + 0.03 * log(1e-6 + fract(sin(uTime) * 4373.11));
  float accum = s * 0.25;
  float prev = 0.0;
  float tw = 0.0;

  for (int i = 0; i < 26; i++) {
    if (i >= iters) break;
    float mag = dot(p, p);
    p = abs(p) / max(mag, 1e-6) + vec3(-0.5, -0.4, -1.5);
    float w = exp(-float(i) / 7.0);
    accum += w * exp(-strength * pow(abs(mag - prev), 2.2));
    tw += w;
    prev = mag;
  }
  return max(0.0, 5.0 * accum / max(tw, 1e-5) - 0.7);
}

// Two decorrelated hashes mixed, so the stars do not fall on any visible lattice.
vec3 nrand3(vec2 co) {
  vec3 a = fract(cos(co.x * 8.3e-3 + co.y) * vec3(1.3e5, 4.7e5, 2.9e5));
  vec3 b = fract(sin(co.x * 0.3e-3 + co.y) * vec3(8.1e5, 1.0e5, 0.1e5));
  return mix(a, b, 0.5);
}

void main() {
  vec2 uv = (vUv - 0.5) * 2.0;
  vec2 uvs = uv * vec2(uAspect, 1.0) / max(uAspect, 1.0) / p_zoom;

  float t = uTime * p_drift;

  vec3 p = vec3(uvs * 0.25, 0.0) + vec3(1.0, -1.3, 0.0);
  p += 0.2 * vec3(sin(t / 16.0), sin(t / 12.0), sin(t / 128.0));

  // Soft frame edge. Everything is multiplied by it, so the nebula fades out at
  // the border rather than being cut off by it.
  float v = (1.0 - exp((abs(uv.x) - 1.0) * 6.0)) * (1.0 - exp((abs(uv.y) - 1.0) * 6.0));

  int iters = int(clamp(p_detail, 8.0, 26.0));
  float f1 = field(p, uMid, iters);

  // Second layer, further out and breathing on its own clock, so the two slide
  // past one another instead of moving as one sheet.
  float z2 = 4.0 + sin(t * 0.11) * 0.2 + 0.2 + sin(t * 0.15) * 0.3 + 0.4;
  vec3 p2 = vec3(uvs / z2, 1.5) + vec3(2.0, -1.3, -1.0);
  p2 += 0.25 * vec3(sin(t / 16.0), sin(t / 12.0), sin(t / 128.0));
  float f2 = field(p2, uHigh, max(8, iters * 2 / 3));

  // Colour by density: dense cores sit at the bright end of the ramp, the thin
  // outskirts at the dark end, which is what gives the cloud its depth.
  vec3 col = palClamp(0.15 + 0.8 * sat(f1)) * f1 * f1 * (0.5 + 1.2 * uBass);
  col += palClamp(0.35 + 0.6 * sat(f2)) * f2 * f2 * (0.4 + 1.0 * uSub) * 0.8;
  col *= mix(0.4, 1.0, v) * p_bright;

  // Stars, from both layers' coordinate frames so they parallax with them.
  vec2 seed = floor(p.xy * 2.0 * uResolution.x);
  vec2 seed2 = floor(p2.xy * 2.0 * uResolution.x);
  float star = pow(nrand3(seed).y, 40.0) + pow(nrand3(seed2).y, 40.0);
  col += vec3(0.85, 0.9, 1.0) * star * p_stars * v;

  col *= 0.92 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
