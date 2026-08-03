#include "common.glsl"
#include "palette.glsl"

// Spiral wipe. The boundary is a function of angle AND radius, so the edge winds
// around the centre instead of sweeping like a clock hand. Both scenes are also
// twisted toward the boundary, which sells it as motion rather than a mask.

void main() {
  float k = smoothstep(0.0, 1.0, clamp(uAmount, 0.0, 1.0));
  vec2 p = centered(vUv, uAspect);

  float r = length(p) / 1.45;              // 0 centre, ~1 corner
  float a = atan(p.y, p.x) / TAU + 0.5;    // 0..1 around

  // Closing inward: the threshold radius shrinks as k rises, offset per angle.
  float spiral = fract(a + r * p_turns);
  float edge = 1.0 - k;
  float mask = smoothstep(edge + 0.06, edge - 0.06, r - spiral * 0.12);

  // Twist both layers, hardest right at the boundary.
  float twist = p_swirl * (1.0 - abs(r - edge) * 2.0) * k;
  vec2 uvA = (rot(twist * 0.35) * p) / vec2(uAspect, 1.0) * 0.5 + 0.5;
  vec2 uvB = (rot(-twist * 0.5) * p) / vec2(uAspect, 1.0) * 0.5 + 0.5;

  vec3 prev = texture(uPrev, clamp(uvA, 0.0, 1.0)).rgb;
  vec3 next = texture(uNext, clamp(uvB, 0.0, 1.0)).rgb;

  vec3 col = mix(prev, next, mask);

  // Bright filament along the spiral edge.
  float rim = smoothstep(0.05, 0.0, abs(r - edge - spiral * 0.12));
  col += pal(fract(a + uTime * 0.1)) * rim * 0.8 * sin(k * PI);

  fragColor = vec4(col, 1.0);
}
