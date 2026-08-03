#include "common.glsl"
#include "palette.glsl"

// Truchet tiles: each cell holds two quarter-arcs, in one of two orientations.
// Because every arc meets its neighbours at the cell edge midpoints, the tiles
// join into continuous paths however they are shuffled - which is the whole
// appeal, and why it survives cells re-rolling live.

void main() {
  vec2 p = centered(vUv, uAspect) * p_scale;
  p += vec2(uTime * p_drift, uTime * p_drift * 0.6);

  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;

  // Orientation, re-rolled occasionally so the maze rewires on the beat.
  float roll = hash12(cell);
  float epoch = floor(uTime * 0.7);
  if (hash12(cell + epoch * 17.0) < p_flip) roll = hash12(cell + epoch * 31.0);
  bool flipped = roll > 0.5;

  // Mirror one diagonal to switch between the two tile orientations.
  vec2 q = flipped ? vec2(f.x, -f.y) : f;

  // Two quarter-arcs centred on opposite corners.
  float d1 = abs(length(q - vec2(0.5, 0.5)) - 0.5);
  float d2 = abs(length(q - vec2(-0.5, -0.5)) - 0.5);
  float d = min(d1, d2);

  float w = p_thickness;
  float line = smoothstep(w, w - 0.03, d);

  // Colour along the path: use the arc's angle so colour flows around curves
  // rather than restarting at every cell.
  float along = atan(q.y - (d1 < d2 ? 0.5 : -0.5), q.x - (d1 < d2 ? 0.5 : -0.5));
  vec3 pathCol = pal(fract(along / TAU + hash12(cell) * 0.2 + uTime * 0.05));

  vec3 col = palClamp(0.05) * (0.6 + 0.4 * hash12(cell));
  col = mix(col, pathCol, line);

  // Bright core inside the stroke.
  col += pathCol * smoothstep(w * 0.45, 0.0, d) * 0.7;

  // Junction dots where paths meet the cell edges.
  vec2 edge = abs(f);
  float node = smoothstep(0.06, 0.0, min(
    length(f - vec2(0.5, 0.0)), length(f - vec2(0.0, 0.5))));
  col += palClamp(0.92) * node * 0.35 * uBeatPulse;

  col *= 0.9 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
