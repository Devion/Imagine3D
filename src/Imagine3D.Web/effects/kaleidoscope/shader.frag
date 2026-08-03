#include "common.glsl"

void main() {
  vec2 p = centered(vUv, uAspect) / max(0.01, p_zoom);

  float r = length(p);
  float a = atan(p.y, p.x) + uTime * p_spin;

  // Fold the angle into one wedge and mirror alternate wedges, which is what
  // makes the seams line up instead of showing hard cuts.
  float seg = TAU / max(2.0, p_segments);
  a = mod(a, seg);
  a = abs(a - seg * 0.5);

  vec2 q = vec2(cos(a), sin(a)) * r;

  // Back to UV space, mirrored at the edges so there is always something to
  // sample rather than a clamped smear.
  vec2 uv = q / vec2(uAspect, 1.0) * 0.5 + 0.5;
  uv = abs(fract(uv * 0.5) * 2.0 - 1.0);

  vec3 col = texture(uPrev, uv).rgb;
  vec3 base = texture(uPrev, vUv).rgb;
  fragColor = vec4(mix(base, col, clamp(uAmount, 0.0, 1.0)), 1.0);
}
