#include "common.glsl"
#include "palette.glsl"

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  // Two centres orbiting in opposite directions.
  vec2 c1 = vec2(cos(t), sin(t * 1.3)) * p_separation;
  vec2 c2 = vec2(cos(-t * 0.8 + 2.0), sin(-t * 1.1)) * p_separation;

  float r1 = length(uv - c1) * p_frequency;
  float r2 = length(uv - c2) * p_frequency;

  float a = sin(r1);
  float b = sin(r2);

  // Product of the two ring fields: where they align you get the moire beat.
  float v = a * b;

  vec3 col;
  if (p_hard > 0.5) {
    // Two-tone rings, which is what a 1-bitplane display would have produced.
    float bit = step(0.0, v);
    col = mix(palClamp(0.12), palClamp(0.8), bit);
    // Third field adds a slow colour wash so it is not literally monochrome.
    col *= 0.7 + 0.5 * (0.5 + 0.5 * sin(r1 * 0.13 - t * 2.0));
  } else {
    col = palClamp(v * 0.5 + 0.5);
  }

  col *= 1.0 - 0.35 * length(uv) * 0.6;
  col *= 0.88 + 0.3 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
