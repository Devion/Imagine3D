#include "common.glsl"
#include "palette.glsl"

void main() {
  float k = smoothstep(0.0, 1.0, clamp(uAmount, 0.0, 1.0));
  vec2 p = centered(vUv, uAspect);

  float d;
  if (p_sides < 2.0) {
    d = length(p);
  } else {
    // Regular-polygon distance: fold the angle into one wedge, then measure.
    float n = floor(p_sides);
    float a = atan(p.y, p.x) + uTime * p_spin;
    float seg = TAU / n;
    float wedge = mod(a, seg) - seg * 0.5;
    d = length(p) * cos(wedge) / cos(seg * 0.5);
  }

  // Radius has to reach the corners, not just the edges, or the last sliver of
  // the outgoing scene lingers in the corners after the wipe should be done.
  float maxR = length(vec2(uAspect, 1.0));
  float radius = k * maxR;

  float mask = smoothstep(radius + p_softness, radius - p_softness, d);

  vec3 prev = texture(uPrev, vUv).rgb;
  vec3 next = texture(uNext, vUv).rgb;
  vec3 col = mix(prev, next, mask);

  float rim = smoothstep(0.045, 0.0, abs(d - radius));
  col += palClamp(0.9) * rim * 0.7 * sin(k * PI);

  fragColor = vec4(col, 1.0);
}
