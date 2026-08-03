#include "common.glsl"

void main() {
  float g = clamp(p_amount, 0.0, 1.0) * clamp(uAmount, 0.0, 1.0);
  vec3 base = texture(uPrev, vUv).rgb;

  if (g < 0.01) { fragColor = vec4(base, 1.0); return; }

  // Quantised time so the glitch holds for a few frames rather than shimmering
  // at the frame rate, which is what makes it read as damage rather than noise.
  float tq = floor(uTime * 18.0);

  vec2 uv = vUv;

  // Horizontal slice displacement.
  float slice = floor(uv.y * p_slices);
  float jump = (hash12(vec2(slice, tq)) - 0.5);
  if (abs(jump) > 0.5 - g * 0.5) uv.x = fract(uv.x + jump * 0.3 * g);

  // Block shuffle over a coarse grid.
  if (p_blocks > 0.01) {
    vec2 grid = vec2(16.0, 9.0);
    vec2 cell = floor(uv * grid);
    if (hash12(cell + tq * 3.1) < g * p_blocks) {
      uv += (hash22(cell + tq) - 0.5) * 0.08 * g;
    }
  }

  float sep = 0.008 * g;
  vec3 col = vec3(
    texture(uPrev, uv + vec2(sep, 0.0)).r,
    texture(uPrev, uv).g,
    texture(uPrev, uv - vec2(sep, 0.0)).b);

  // Occasional blown-out or inverted scanline.
  float line = hash12(vec2(floor(uv.y * 180.0), tq));
  if (line > 1.0 - g * 0.08) col = 1.0 - col;
  if (line < g * 0.05) col += 0.5;

  fragColor = vec4(mix(base, col, clamp(uAmount, 0.0, 1.0)), 1.0);
}
