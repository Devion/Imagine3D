#include "common.glsl"
#include "palette.glsl"

// A square column twisted about the vertical axis. Per scanline the square is
// rotated by an angle that increases with height; the four faces are found by
// projecting the rotated corners to x and testing which span contains the pixel.

void main() {
  vec2 uv = centered(vUv, uAspect);

  float y = vUv.y;
  float angle = uTime * p_spin + y * p_twist;

  // Sway so the column is not rigidly centred.
  float cx = sin(uTime * 0.6 + y * 2.0) * p_wobble;

  vec3 col = palClamp(0.05 + 0.12 * (1.0 - y)) * 0.5;   // backdrop

  // Corner x-projections of a rotated unit square, per scanline.
  float best = 1e9;
  int face = -1;
  for (int i = 0; i < 4; i++) {
    float a0 = angle + float(i) * (PI * 0.5);
    float a1 = angle + float(i + 1) * (PI * 0.5);
    float x0 = cos(a0) * p_width + cx;
    float x1 = cos(a1) * p_width + cx;

    float lo = min(x0, x1), hi = max(x0, x1);
    if (uv.x < lo || uv.x > hi) continue;

    // A face is only visible when its normal points at the viewer, which for
    // this projection means the span is traversed in the +z half.
    float depth = (sin(a0) + sin(a1)) * 0.5;
    if (depth > best) continue;
    best = depth;
    face = i;

    // Shade across the face and pick a palette slot per face.
    float k = (uv.x - lo) / max(1e-4, hi - lo);
    float shade = 0.35 + 0.65 * sqrt(max(0.0, 1.0 - abs(k * 2.0 - 1.0)));
    shade *= 0.55 + 0.45 * (-depth * 0.5 + 0.5);

    vec3 faceCol = pal(fract(float(i) * 0.25 + uTime * 0.04 + y * 0.15));
    col = faceCol * shade;

    // Horizontal banding across the column, like the original's line rendering.
    col *= 0.82 + 0.18 * step(0.5, fract(y * uResolution.y * 0.25));
  }

  col *= 0.9 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
