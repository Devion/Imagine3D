#include "common.glsl"
#include "palette.glsl"

// Polar tunnel: 1/r is depth, angle is the wrap around the wall. The whole trick
// is that no geometry exists - it is a coordinate transform.

void main() {
  vec2 uv = centered(vUv, uAspect);

  // Wobble the tunnel centre so the flight path curves.
  uv += vec2(sin(uTime * 0.7), cos(uTime * 0.53)) * p_wobble;

  float r = length(uv);
  float a = atan(uv.y, uv.x);

  float depth = 1.0 / max(r, 0.04);
  float z = depth + uTime * p_speed;

  // Twist increases with depth, so the far end of the tunnel corkscrews.
  float angle = a + z * p_twist;

  vec2 tex = vec2(angle / TAU * p_rings, z);
  vec2 cell = floor(tex);
  float checker = mod(cell.x + cell.y, 2.0);

  // Bands of palette along the tunnel plus the checker as a brightness key.
  vec3 col = pal(fract(z * 0.06 + uTime * 0.02));
  col *= mix(0.45, 1.0, checker);

  // Grid lines make the perspective readable.
  vec2 g = abs(fract(tex) - 0.5);
  float line = smoothstep(0.48, 0.5, max(g.x, g.y));
  col = mix(col, pal(fract(z * 0.06 + 0.5)), line * 0.6);

  // Distance fog toward the centre, opened up by the beat.
  float fog = smoothstep(0.0, 0.55 + 0.25 * uBeatPulse, r);
  col *= fog;
  col += pal(fract(uTime * 0.05)) * (1.0 - fog) * 0.35 * (0.5 + uEnergy);

  fragColor = vec4(col, 1.0);
}
