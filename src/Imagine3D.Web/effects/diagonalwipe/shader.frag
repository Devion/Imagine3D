#include "common.glsl"
#include "palette.glsl"

// A raking diagonal edge.
//
// The boundary is not one line: the across-axis is sliced into strips and each
// strip's edge is offset by its own hash, so the wipe arrives as a rake. Set
// `stagger` to 0 and it collapses back to a clean straight cut.

void main() {
  float k = clamp(uAmount, 0.0, 1.0);
  vec2 p = centered(vUv, uAspect);

  float ang = p_angle * PI;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 perp = vec2(-dir.y, dir.x);

  float along = dot(p, dir);
  float across = dot(p, perp);

  float strip = floor(across * p_teeth);
  float lead = (hash11(strip * 1.7 + 4.0) - 0.5) * p_stagger;

  float fold = along - abs(across) * p_chevron + lead;

  // The edge has to sweep past both extremes or the wipe never finishes; the
  // chevron and the comb both widen the range it has to cover.
  float extent = (uAspect + 1.0) * (1.0 + p_chevron) + p_stagger + 0.2;
  float edge = mix(-extent, extent, k);

  // Softest in the middle of the sweep, crisp at either end, so it starts and
  // lands cleanly but does not read as a hard-edged mask throughout.
  float soft = 0.02 + 0.05 * (1.0 - abs(k * 2.0 - 1.0));
  float m = smoothstep(edge + soft, edge - soft, fold);

  // Shove the outgoing frame along the wipe axis as it leaves. Centred units are
  // twice the uv range in y and 2*aspect in x, so the offset converts back.
  vec2 push = dir * 0.05 * k / (2.0 * vec2(uAspect, 1.0));

  vec3 prev = texture(uPrev, vUv + push).rgb;
  vec3 next = texture(uNext, vUv).rgb;
  vec3 col = mix(prev, next, m);

  // Glowing leading line, coloured per strip so the rake is legible.
  float d = abs(fold - edge);
  col += pal(fract(uTime * 0.12 + strip * 0.03)) * smoothstep(0.11, 0.0, d) * 1.0;
  col += vec3(1.0) * smoothstep(0.018, 0.0, d) * 0.9;

  fragColor = vec4(col, 1.0);
}
