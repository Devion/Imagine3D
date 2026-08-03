#include "common.glsl"
#include "palette.glsl"

// Rotate + scale the sampling coordinate and tile it. The "texture" is generated
// rather than sampled, which keeps it crisp at any zoom.

vec3 tile(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);

  float id = hash12(cell);

  // Checkerboard base with a per-cell inset square and a diagonal.
  float checker = mod(cell.x + cell.y, 2.0);
  vec3 col = mix(pal(fract(0.1 + id * 0.3)), pal(fract(0.55 + id * 0.3)), checker);

  vec2 c = abs(f - 0.5);
  float square = step(max(c.x, c.y), 0.32);
  col = mix(col, pal(fract(id * 0.7 + 0.3)) * 1.4, square * 0.65);

  float diag = smoothstep(0.03, 0.0, abs(f.x - f.y) - 0.18);
  col = mix(col, vec3(1.0), diag * 0.25 * id);

  // Grid lines so the tiling is legible while it spins.
  float grid = smoothstep(0.47, 0.5, max(c.x, c.y));
  col *= 1.0 - 0.5 * grid;

  return col;
}

void main() {
  vec2 uv = centered(vUv, uAspect);

  float a = uTime * p_spin;
  vec2 p = rot(a) * uv * p_zoom * p_tiles;
  p += vec2(cos(uTime * p_drift), sin(uTime * p_drift * 0.83)) * 2.0;

  vec3 col = tile(p);

  // Slight radial darkening keeps the centre of rotation readable.
  col *= 1.0 - 0.3 * length(uv) * 0.5;
  col *= 0.85 + 0.35 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
