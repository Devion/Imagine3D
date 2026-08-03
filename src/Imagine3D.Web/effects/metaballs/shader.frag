#include "common.glsl"
#include "palette.glsl"

// Classic metaballs: sum 1/d^2 fields and contour the result. The hard banding
// is deliberate - a smooth gradient here looks like a modern blur, not a demo.

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  float field = 0.0;
  int n = int(clamp(p_count, 2.0, 12.0));
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    float fi = float(i);

    // Each blob rides its own lissajous figure, so they never form a pattern.
    vec2 c = vec2(
      sin(t * (0.7 + fi * 0.13) + fi * 1.7) * 0.75,
      cos(t * (0.53 + fi * 0.17) + fi * 2.3) * 0.55);

    float r = p_size * (0.7 + 0.6 * hash11(fi + 3.0));
    float d = length(uv - c);
    field += (r * r) / max(d * d, 1e-4);
  }

  // Contour: field == 1 is the classic surface.
  float v = field;

  vec3 col;
  if (p_bands > 0.5) {
    // Stepped contours - the copper-list look.
    col = palSteps(clamp(v * 0.35, 0.0, 1.0), p_bands);
  } else {
    col = palClamp(clamp(v * 0.35, 0.0, 1.0));
  }

  // Bright rim right at the isosurface.
  float rim = smoothstep(0.06, 0.0, abs(v - 1.0));
  col += rim * 0.6 * (0.5 + uBeatPulse);

  // Outside the field falls to background rather than pure black.
  col *= smoothstep(0.06, 0.5, v) * 0.9 + 0.1;

  fragColor = vec4(col, 1.0);
}
