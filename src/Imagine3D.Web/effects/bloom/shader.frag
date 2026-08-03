#include "common.glsl"

// Single-pass bloom. A proper separable blur across mip levels would be nicer,
// but at these radii a fixed 13-tap cross is visually equivalent and keeps the
// pass count (and therefore the frame time) down.

vec3 bright(vec2 uv) {
  vec3 c = texture(uPrev, uv).rgb;
  float l = luma(c);
  return c * smoothstep(p_threshold, p_threshold + 0.25, l);
}

void main() {
  vec3 base = texture(uPrev, vUv).rgb;

  vec2 px = 1.0 / uResolution;
  vec3 sum = vec3(0.0);
  float total = 0.0;

  const int TAPS = 13;
  for (int i = 0; i < TAPS; i++) {
    float o = float(i - TAPS / 2);
    float w = exp(-o * o / 18.0);
    // Wider horizontally than vertically: the anamorphic streak.
    sum += bright(vUv + vec2(o * px.x * p_radius * p_anamorphic, 0.0)) * w;
    sum += bright(vUv + vec2(0.0, o * px.y * p_radius)) * w;
    total += w * 2.0;
  }

  vec3 glow = sum / max(total, 1e-4) * p_intensity;
  vec3 col = base + glow * clamp(uAmount, 0.0, 1.0);

  fragColor = vec4(col, 1.0);
}
