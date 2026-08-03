#include "common.glsl"

void main() {
  // Gate weave: a sub-pixel wander, the film equivalent of a handheld shot.
  vec2 uv = vUv + vec2(
    sin(uTime * 3.1) * 0.6 + sin(uTime * 7.7) * 0.4,
    cos(uTime * 2.3) * 0.6 + sin(uTime * 5.1) * 0.4) * p_weave;

  vec3 col = texture(uPrev, uv).rgb;

  // Grain reseeded each frame; scaled by luma so shadows stay cleaner than
  // midtones, which is how real film grain behaves.
  float n = hash12(uv * uResolution + fract(uTime) * 1731.0) - 0.5;
  col += n * p_grain * (0.35 + luma(col));

  vec2 c = (vUv - 0.5) * 2.0;
  float vig = 1.0 - p_vignette * dot(c, c) * 0.5;
  col *= vig;

  // Slight black lift so the darks read as film rather than clipped digital.
  col = col * (1.0 - p_lift) + p_lift;

  vec3 base = texture(uPrev, vUv).rgb;
  fragColor = vec4(mix(base, col, clamp(uAmount, 0.0, 1.0)), 1.0);
}
