#include "common.glsl"

void main() {
  float k = smoothstep(0.0, 1.0, clamp(uAmount, 0.0, 1.0));
  vec2 p = centered(vUv, uAspect);

  float maxR = length(vec2(uAspect, 1.0));
  float r = length(p);
  float front = k * maxR;

  // Ring of disturbance travelling with the front.
  float band = smoothstep(p_width, 0.0, abs(r - front));
  float wave = sin((r - front) * p_waves * PI) * band;

  vec2 dir = normalize(p + 1e-5);
  vec2 offset = dir * wave * p_strength;

  vec3 prev = texture(uPrev, clamp(vUv + offset, 0.0, 1.0)).rgb;
  vec3 next = texture(uNext, clamp(vUv + offset * 0.6, 0.0, 1.0)).rgb;

  // Soft boundary that follows the ripple, so the edge is never a hard circle.
  float mask = smoothstep(front + 0.06, front - 0.06, r + wave * 0.05);
  vec3 col = mix(prev, next, mask);

  // Specular glint on the crest.
  col += vec3(0.35) * max(0.0, wave) * band;

  fragColor = vec4(col, 1.0);
}
