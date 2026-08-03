#include "common.glsl"
#include "palette.glsl"

void main() {
  float k = clamp(uAmount, 0.0, 1.0);
  vec2 p = centered(vUv, uAspect);

  float a = atan(p.y, p.x) / TAU + 0.5;   // 0..1 around the circle
  float edge = k;

  vec3 prev = texture(uPrev, vUv).rgb;
  vec3 next = texture(uNext, vUv).rgb;

  float sweep = smoothstep(edge + 0.01, edge - 0.01, a);
  vec3 col = mix(prev, next, sweep);

  // Bright hand at the boundary.
  float hand = smoothstep(0.02, 0.0, abs(a - edge));
  col += pal(fract(uTime * 0.1)) * hand * 0.9;

  fragColor = vec4(col, 1.0);
}
