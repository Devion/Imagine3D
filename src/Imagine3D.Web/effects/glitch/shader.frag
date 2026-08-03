#include "common.glsl"
#include "noise.glsl"

// Digital corruption.
//
// The previous version inverted whole scanlines (`col = 1.0 - col`) and blew
// others out to white. Both are hard-edged full-width stripes, both re-rolled
// eighteen times a second, and neither resembles anything a real signal does -
// they just read as damage to the *render* rather than to the picture.
//
// What actually looks like a corrupted frame is misalignment: bands of the image
// torn sideways, the colour channels drifting apart at the tear, and blocks
// landing a few pixels off. All of that is soft-edged and all of it preserves
// the underlying image, so the scene stays readable through the effect.

void main() {
  float g = clamp(p_amount, 0.0, 1.0) * clamp(uAmount, 0.0, 1.0);
  vec3 base = texture(uPrev, vUv).rgb;

  if (g < 0.01) { fragColor = vec4(base, 1.0); return; }

  // Hold each burst for a few frames rather than reshuffling every frame, so it
  // reads as a fault that persists briefly instead of continuous noise.
  float tq = floor(uTime * 11.0);

  vec2 uv = vUv;

  // --- horizontal tears ------------------------------------------------------
  // A few soft bands slide sideways. `tear` is how strongly this pixel is inside
  // one, and drives the colour separation and highlight below.
  float tear = 0.0;
  vec2 slip = vec2(0.0);

  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 h = hash22(vec2(tq, fi * 7.3));

    // Only some bands are live at a given moment.
    if (hash12(vec2(tq * 1.7, fi)) > 0.35 + g * 0.55) continue;

    float centre = h.x;
    float height = mix(0.012, 0.075, h.y) * (0.5 + g);
    float m = smoothstep(height, height * 0.3, abs(uv.y - centre));

    tear = max(tear, m);
    slip += vec2(
      (hash12(vec2(tq, fi * 3.1)) - 0.5) * 0.09,
      (hash12(vec2(tq, fi * 5.9)) - 0.5) * 0.012) * m;
  }

  uv += slip * g;

  // --- block displacement ----------------------------------------------------
  if (p_blocks > 0.01) {
    vec2 grid = vec2(14.0, 9.0);
    vec2 cell = floor(vUv * grid);
    if (hash12(cell + tq * 3.1) < g * p_blocks * 0.45)
      uv.x += (hash12(cell + tq) - 0.5) * 0.04 * g;
  }

  // Clamp rather than fract: wrapping pulled the far edge of the frame into the
  // near one and left a hard vertical seam down the middle of every slice.
  uv = clamp(uv, 0.0, 1.0);

  // --- colour separation, concentrated at the tears -------------------------
  float sep = (0.0015 + 0.007 * tear) * g;
  vec3 col = vec3(
    texture(uPrev, clamp(uv + vec2(sep, 0.0), 0.0, 1.0)).r,
    texture(uPrev, uv).g,
    texture(uPrev, clamp(uv - vec2(sep, 0.0), 0.0, 1.0)).b);

  // --- gentle luma banding ---------------------------------------------------
  // Replaces the blown-out white lines: same sense of interference, but it
  // modulates the picture instead of erasing rows of it.
  float band = fbm(vec2(uv.y * 55.0, tq * 0.6), 2, 2.0, 0.5);
  col *= 1.0 + (band - 0.5) * 0.45 * g;

  // --- dropout ---------------------------------------------------------------
  // Where the signal "fails", the band desaturates and dims. This is what the
  // inversion was reaching for, without throwing the image away.
  float drop = smoothstep(0.82, 0.97, hash12(vec2(floor(uv.y * 34.0), tq))) * g;
  col = mix(col, vec3(luma(col)) * 0.4, drop * 0.65);

  // A cool highlight along the tear edge, tinted rather than pure white.
  col += vec3(0.55, 0.75, 1.0) * tear * 0.16 * g;

  fragColor = vec4(mix(base, col, clamp(uAmount, 0.0, 1.0)), 1.0);
}
