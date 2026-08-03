#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Starfield with continuous outward flow.
//
// Stars live in a polar lattice indexed by (sector, shell) where the shell
// coordinate is 1/radius. Advancing that coordinate with time moves a star from
// the centre out to the frame edge along a straight line, forever - there is no
// per-layer depth counter to wrap, which is what matters here.
//
// The previous version cycled each layer's depth with fract() and rescaled its
// whole grid on the wrap. Every layer therefore repopulated several times a
// second, which read as constant popping rather than travel, and combined with a
// hard per-beat flash it was genuinely unpleasant to watch. Nothing in this
// version resets, and the beat only modulates brightness gently.

void main() {
  vec2 uv = centered(vUv, uAspect);

  // Barrel warp, kept subtle - this used to lurch on every downbeat.
  uv *= 1.0 + p_warp * dot(uv, uv) * 0.12;

  float r = length(uv);
  float a = atan(uv.y, uv.x) / TAU + 0.5;   // 0..1 around the frame

  // Travel. Mostly forward, occasionally easing backwards and returning: the
  // sine term is what makes it roll back, and it only wins over the linear term
  // for part of each slow cycle, so a reversal is an event rather than a wobble.
  float travel = uTime * p_speed
               + p_rollback * 2.4 * sin(uTime * p_rollRate);

  vec3 col = vec3(0.0);
  const int LAYERS = 5;

  for (int i = 0; i < LAYERS; i++) {
    float fi = float(i);

    // Integer sector count so the lattice wraps cleanly at the seam.
    float sectors = floor(13.0 + fi * 8.0);
    float layerSpeed = 0.35 + fi * 0.28;

    // Shell coordinate. Stars sit at integer shells; a star at shell k is drawn
    // where 1/r + travel = k, so as travel grows r grows - outward.
    float w = 1.0 / max(r, 0.02) + travel * layerSpeed + fi * 31.7;

    // Offset each shell's sector boundaries by a per-shell amount. Without this
    // every shell shares the same angular grid and the stars line up into
    // visible radial spokes - a sunburst rather than a sky.
    float shell = floor(w);
    float ai = a * sectors + hash11(shell + fi * 5.7) * sectors;

    vec2 cell = vec2(mod(floor(ai), sectors), shell);
    vec2 f = vec2(fract(ai), fract(w));

    float bright = hash12(cell + fi * 17.1);
    if (bright < 1.0 - p_density / 200.0) continue;

    vec2 jit = hash22(cell + fi * 71.3) * 0.7 + 0.15;

    // Offsets from the star's centre, converted from lattice units to screen
    // units. d(1/w) = -dw / w^2 = -dw * r^2, which is what makes stars grow as
    // they approach the edge without any explicit size ramp.
    float dA = (f.x - jit.x) * (TAU / sectors) * r;

    // r*r is the exact derivative of 1/w, but it grows without bound and turned
    // stars near the frame edge into long comets. Clamped, they stay stars.
    float dW = (f.y - jit.y) * min(r * r, 0.35);

    // Mild radial streak, not a smear.
    float d = length(vec2(dA, dW / (1.0 + p_streak * 3.0)));

    float glow = 0.005 / (d + 0.005);
    float star = pow(glow, 1.7) * (0.35 + bright * 0.8);

    // Fade in as a star is born at the centre and out only once it is past the
    // corner. centered() puts the corner at r ~2.0 on 16:9, so fading from 1.1
    // left the outer frame permanently black.
    star *= smoothstep(0.0, 0.09, r) * smoothstep(2.9, 2.2, r);

    col += palClamp(0.55 + 0.45 * hash11(bright * 91.0)) * star;
  }

  col *= 1.35;

  // Faint nebula so the background is never a dead flat black. Drifts with the
  // same travel value, so it never contradicts the direction of flow.
  float neb = fbm(uv * 1.4 + vec2(travel * 0.012, 0.0), 4, 2.0, 0.5);
  neb = smoothstep(0.45, 0.85, neb);
  col += palClamp(0.2 + 0.3 * neb) * neb * 0.26;

  // Gentle: a hard beat flash on a full-frame starfield is a strobe.
  col *= 0.94 + 0.12 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
