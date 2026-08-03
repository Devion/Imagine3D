#include "common.glsl"

void main() {
  float k = smoothstep(0.0, 1.0, clamp(uAmount, 0.0, 1.0));
  vec3 a = texture(uPrev, vUv).rgb;
  vec3 b = texture(uNext, vUv).rgb;
  fragColor = vec4(mix(a, b, k), 1.0);
}
