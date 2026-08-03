#include "common.glsl"
#include "palette.glsl"

// Voronoi cells with true edge distance.
//
// A first pass finds the nearest feature point; a second measures distance to
// the perpendicular bisector between it and each neighbour. That second pass is
// what produces even, glowing borders - F2-F1 alone gives edges that thin out
// toward the cell corners.

void main() {
  vec2 p = centered(vUv, uAspect) * p_scale;
  float t = uTime * p_speed;

  vec2 baseCell = floor(p);
  vec2 f = p - baseCell;

  // --- pass 1: nearest point ---
  vec2 bestOffset = vec2(0.0);
  vec2 bestCell = vec2(0.0);
  float bestDist = 8.0;

  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 cell = baseCell + g;
    vec2 jitter = hash22(cell);
    // Animate each point on its own little orbit.
    vec2 o = g + 0.5 + (sin(t + TAU * jitter) * 0.5) * p_jitter;
    // Shatter pushes points away from the cell centre.
    o += normalize(o - f + 1e-5) * p_shatter * 0.4;

    vec2 r = o - f;
    float d = dot(r, r);
    if (d < bestDist) { bestDist = d; bestOffset = r; bestCell = cell; }
  }

  // --- pass 2: distance to the border ---
  float border = 8.0;
  for (int j = -2; j <= 2; j++)
  for (int i = -2; i <= 2; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 cell = baseCell + g;
    vec2 jitter = hash22(cell);
    vec2 o = g + 0.5 + (sin(t + TAU * jitter) * 0.5) * p_jitter;
    o += normalize(o - f + 1e-5) * p_shatter * 0.4;

    vec2 r = o - f;
    vec2 diff = r - bestOffset;
    if (dot(diff, diff) < 1e-5) continue;          // the winning point itself
    // Distance to the bisector between the winner and this neighbour.
    border = min(border, dot(0.5 * (bestOffset + r), normalize(diff)));
  }

  float id = hash12(bestCell);

  // Per-cell shading: a fake normal from the offset gives each shard a facet.
  vec3 n = normalize(vec3(bestOffset * 1.2, 0.8));
  float light = 0.35 + 0.65 * max(0.0, dot(n, normalize(vec3(0.5, 0.6, 0.6))));

  vec3 col = pal(fract(id * 0.8 + uTime * 0.03)) * light;

  // Cells breathe individually, on their own phase.
  col *= 0.75 + 0.35 * sin(uTime * 2.0 + id * TAU) * uRms + 0.2 * uBeatPulse;

  // Glowing borders.
  float e = smoothstep(p_edge, 0.0, border);
  col = mix(col, palClamp(0.95), e * 0.85);
  col += palClamp(0.85) * smoothstep(p_edge * 2.5, 0.0, border) * 0.25;

  fragColor = vec4(col, 1.0);
}
