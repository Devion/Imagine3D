#include "common.glsl"

void main() {
  float k = clamp(uAmount, 0.0, 1.0);

  // Chunky cells rather than per-pixel, so it reads as a deliberate wipe.
  vec2 cell = floor(vUv * uResolution / 12.0);
  float threshold = hash12(cell);

  vec3 a = texture(uPrev, vUv).rgb;
  vec3 b = texture(uNext, vUv).rgb;

  float flipped = step(threshold, k);
  vec3 col = mix(a, b, flipped);

  // Cells brighten as they turn over, which gives the wipe a leading edge.
  col += vec3(0.6) * flipped * smoothstep(0.12, 0.0, k - threshold);

  fragColor = vec4(col, 1.0);
}
