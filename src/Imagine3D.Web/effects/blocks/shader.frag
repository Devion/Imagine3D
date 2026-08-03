#include "common.glsl"
#include "palette.glsl"

void main() {
  float k = clamp(uAmount, 0.0, 1.0);

  float cols = max(2.0, p_columns);
  float rows = max(2.0, floor(cols / uAspect));
  vec2 grid = vec2(cols, rows);

  vec2 cell = floor(vUv * grid);
  vec2 within = fract(vUv * grid);

  // Order: a diagonal sweep blended with per-tile randomness.
  float diagonal = (cell.x / cols + cell.y / rows) * 0.5;
  float noise = hash12(cell);
  float order = mix(noise, diagonal, clamp(p_sweep, 0.0, 1.0));

  // Each tile turns over a short window around its own moment.
  float local = clamp((k - order * 0.75) / 0.25, 0.0, 1.0);

  vec3 prev = texture(uPrev, vUv).rgb;

  // The tile scales up as it flips, sampling the incoming scene from a slightly
  // shrunken copy of itself - reads as the tile rotating toward the viewer.
  float s = 1.0 + p_pop * (1.0 - local);
  vec2 uvNext = (within - 0.5) / s + 0.5;
  uvNext = (cell + clamp(uvNext, 0.0, 1.0)) / grid;
  vec3 next = texture(uNext, uvNext).rgb;

  vec3 col = mix(prev, next, step(0.5, local));

  // Flash as a tile turns, and a dark gutter while it is mid-flip.
  float turning = 1.0 - abs(local * 2.0 - 1.0);
  col *= 1.0 - 0.55 * turning;
  col += palClamp(0.85) * turning * 0.4;

  fragColor = vec4(col, 1.0);
}
