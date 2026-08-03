#include "common.glsl"

void main() {
  vec2 c = vUv - 0.5;

  // Separation grows with radius, the way a real lens disperses.
  float amount = p_strength * pow(length(c) * 2.0, p_falloff);
  vec2 dir = normalize(c + 1e-5) * amount;

  vec3 col = vec3(
    texture(uPrev, vUv + dir).r,
    texture(uPrev, vUv).g,
    texture(uPrev, vUv - dir).b);

  vec3 base = texture(uPrev, vUv).rgb;
  fragColor = vec4(mix(base, col, clamp(uAmount, 0.0, 1.0)), 1.0);
}
