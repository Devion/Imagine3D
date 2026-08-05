#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"

// The same spectrum as `spectrum`, wrapped around a core instead of stood on a
// baseline — the shape every music player draws around its artwork.
//
// The bars are straight radial capsules, not polar wedges. A wedge computed in
// (angle, radius) space is wider at its tip than at its root and its "square"
// end is curved, which reads as a pie chart; a capsule laid along its own
// direction vector is the same width all the way out and takes a round cap for
// free, which reads as a bar. The cost is one 2x2 rotation per pixel.
//
// The frequency axis is mirrored across the circle, so the two halves are each
// a full sweep from the sub band out to air. That is a real convention, not a
// symmetry trick: it puts the loudest, slowest part of the spectrum on one axis
// of the frame and the fastest on the other, so the ring breathes on the low end
// and glitters at right angles to it.

vec3 gCap;

/// Light emitted by the ring of bars at p, in fitted units.
vec3 ringLight(vec2 p, float aa) {
  float bars = clamp(floor(p_bars + 0.5), 8.0, 160.0);
  float R0 = clamp(p_inner, 0.08, 0.7);
  float reach = clamp(p_reach, 0.02, 1.2);

  // Index in the rotating frame, so a bar keeps its band as the ring turns.
  // Wrapped before it is floored: without the fract() the index runs off past a
  // full turn and the whole far side of the ring pins to the top band.
  float spun = uTime * p_spin;
  float sect = fract((atan(p.y, p.x) + spun) / TAU + 0.5);
  float bar = floor(sect * bars);
  float ca = (bar + 0.5) / bars * TAU - PI - spun;

  float u = (bar + 0.5) / bars;
  float x = abs(1.0 - 2.0 * u);     // mirrored: sub at one pole, air at the seam

  float n = valueNoise(vec2(bar * 1.9, uTime * 2.0)) - 0.5;
  float shape = max(0.0, 1.0 + p_detail * n * (1.0 + 1.4 * uOnset));

  float level = clamp(spectrumNow(x) * shape, 0.0, 1.0);
  float cap = clamp(spectrumPeak(x) * shape, 0.0, 1.0);

  // Into the bar's own frame: y runs outward, x across it.
  vec2 dir = vec2(cos(ca), sin(ca));
  vec2 q = vec2(dot(p, vec2(-dir.y, dir.x)), dot(p, dir));

  float w = TAU / bars * R0 * 0.33;
  float root = R0 + w;
  float len = max(0.0, level * reach);

  float d = sdSegment2(q, vec2(0.0, root), vec2(0.0, root + len)) - w;
  vec3 c = palClamp(0.14 + 0.78 * clamp((q.y - root) / max(0.05, reach), 0.0, 1.0));

  vec3 emit = c * fill(d, aa) * 1.15;
  emit += c * exp(-max(0.0, d) / (w * 1.7)) * 0.45 * p_glow;

  // Peak cap: a tangential dash floating just past the bar's tip.
  float capR = root + max(0.0, cap * reach) + w * 1.6;
  float capD = sdRoundBox2(q - vec2(0.0, capR), vec2(w * 1.15, w * 0.34), w * 0.3);
  emit += gCap * fill(capD, aa) * 1.6 * smoothstep(0.02, 0.10, cap);

  return emit;
}

void main() {
  // Fit the whole instrument inside the shorter axis, so the ring is a ring in
  // portrait as well as landscape rather than running off the sides.
  float fit = min(uAspect, 1.0) * 1.02;
  vec2 p = centered(vUv, uAspect) / fit;
  float aa = pixel() / fit;

  float R0 = clamp(p_inner, 0.08, 0.7);
  float reach = clamp(p_reach, 0.02, 1.2);
  float rad = length(p);

  gCap = mix(vec3(1.0), palClamp(0.99), 0.6);

  // --- backdrop -----------------------------------------------------------
  vec3 col = palClamp(0.02) * (0.55 + 0.45 * exp(-rad * 0.9));
  col += palClamp(0.30) * fbm(p * 1.6 + vec2(0.0, uTime * 0.04), 4, 2.0, 0.5) * 0.05;

  // --- core ---------------------------------------------------------------
  // A pool of stirred light rather than a flat disc: the low end pumps its
  // brightness, so the middle of the frame carries the kick on its own.
  float pool = fbm(p * 5.0 + vec2(uTime * 0.12, uTime * 0.2), 4, 2.0, 0.5);
  vec3 coreCol = palClamp(0.22 + 0.55 * pool) * (0.30 + 0.85 * uBass + 0.55 * uBeatPulse);
  coreCol *= 1.0 - 0.55 * smoothstep(0.35, 1.0, rad / (R0 * 0.90));
  col = mix(col, coreCol, fill(rad - R0 * 0.90, aa));

  float rim = abs(rad - R0 * 0.93);
  col += palClamp(0.95) * (fill(rim - 0.004, aa) * 0.55 + exp(-rim * 50.0) * 0.30)
         * (0.75 + 0.75 * uBeatPulse);

  // --- pressure rings leaving the core on the beat ------------------------
  for (int i = 0; i < 3; i++) {
    float age = fract(uBar + float(i) / 3.0);
    float d = abs(rad - (R0 * 0.9 + age * (reach + 0.45)));
    col += palClamp(0.85) * exp(-d * 85.0) * (1.0 - age) * (1.0 - age) * 0.30 * p_glow;
  }

  // --- the bars -----------------------------------------------------------
  col += ringLight(p, aa);

  // --- dial ring ----------------------------------------------------------
  // A fine scale outside the bars, which is what stops the ring from ending in
  // mid-air: the bars now measure against something.
  float RD = R0 + reach + 0.07;
  float dr = abs(rad - RD);
  col += palClamp(0.45) * fill(dr - 0.0022, aa) * 0.35;

  float tickA = (atan(p.y, p.x) / TAU + 0.5) * 96.0;
  float toTick = abs(fract(tickA) - 0.5);
  float major = 1.0 - step(0.5, mod(floor(tickA), 8.0));
  float tickLen = mix(0.016, 0.034, major);
  vec2 tq = vec2((toTick - 0.5) * (TAU * RD / 96.0), rad - RD - tickLen * 0.5);
  col += palClamp(0.6) * fill(sdBox2(tq, vec2(mix(0.0016, 0.0028, major), tickLen * 0.5)), aa) * 0.5;

  col *= 1.0 - 0.30 * pow(clamp(rad / 1.35, 0.0, 1.0), 2.5);
  col *= 0.95 + 0.12 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
