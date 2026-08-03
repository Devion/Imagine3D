#include "common.glsl"

void main() {
  float cols = max(8.0, p_size);
  // Square pixels regardless of aspect: derive the row count from the ratio.
  float rows = max(8.0, cols / uAspect);

  vec2 grid = vec2(cols, rows);
  vec2 uv = (floor(vUv * grid) + 0.5) / grid;

  vec3 col = texture(uPrev, uv).rgb;
  vec3 base = texture(uPrev, vUv).rgb;
  fragColor = vec4(mix(base, col, clamp(uAmount, 0.0, 1.0)), 1.0);
}
