#include "common.glsl"

void main() {
  float k = clamp(uAmount, 0.0, 1.0);

  // Violence peaks in the middle of the transition and resolves at both ends.
  float chaos = sin(k * PI);

  // Horizontal slices jump sideways by a per-slice random amount.
  float sliceH = mix(60.0, 12.0, hash11(floor(k * 6.0)));
  float slice = floor(vUv.y * sliceH);
  float jump = (hash12(vec2(slice, floor(k * 20.0))) - 0.5) * 0.25 * chaos;

  vec2 uvA = vec2(fract(vUv.x + jump), vUv.y);
  vec2 uvB = vec2(fract(vUv.x - jump * 0.6), vUv.y);

  // Channel split, widening with the chaos.
  float sep = 0.012 * chaos;
  vec3 a = vec3(
    texture(uPrev, uvA + vec2(sep, 0.0)).r,
    texture(uPrev, uvA).g,
    texture(uPrev, uvA - vec2(sep, 0.0)).b);
  vec3 b = vec3(
    texture(uNext, uvB - vec2(sep, 0.0)).r,
    texture(uNext, uvB).g,
    texture(uNext, uvB + vec2(sep, 0.0)).b);

  // Per-slice choice of which side wins, so the two scenes interleave rather
  // than fade - that interleaving is what makes it read as a glitch.
  float pick = step(hash12(vec2(slice, 7.0)), k);
  vec3 col = mix(a, b, pick);

  // Blown-out scanlines through the worst of it.
  col += chaos * 0.25 * step(0.7, hash12(vec2(slice, floor(k * 40.0))));

  fragColor = vec4(col, 1.0);
}
