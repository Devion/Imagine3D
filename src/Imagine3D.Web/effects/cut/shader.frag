#include "common.glsl"

void main() {
  float k = clamp(uAmount, 0.0, 1.0);
  vec3 a = texture(uPrev, vUv).rgb;
  vec3 b = texture(uNext, vUv).rgb;
  vec3 col = k < 0.5 ? a : b;
  // A brief flash sells the cut as an impact rather than a glitch.
  col += vec3(1.0) * exp(-k * 22.0) * 0.8;
  fragColor = vec4(col, 1.0);
}
