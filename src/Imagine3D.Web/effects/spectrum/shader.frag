#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"

// A hi-fi LED spectrum analyser: a ladder of segments per bar, a cap holding
// each bar's peak before sliding down, and the whole thing reflected in the
// gloss it stands on.
//
// The analysis carries six band followers, not a full spectrum, so the bars are
// read off a curve through those six points rather than off 28 independent
// filters. That is what the analyser actually knows: the shape across the frame
// is real, the resolution behind it is six. What stops it looking like a drawn
// curve is `detail` — a per-bar deviation scaled by that bar's own level and by
// onset, so the ladder scatters while the music is busy and settles when it is
// not, instead of jittering over a quiet passage.
//
// Everything here is *added* to the card. LEDs are emitters on black; there is
// nothing for them to occlude, and treating them that way is what makes the
// reflection one more add rather than a second compositing path.

const float BASE = -0.44;   // the baseline the bars stand on
const float TOP  =  0.86;   // the top of a full-scale bar

vec3 gCap;

/// Green up to about two thirds, amber, then red — blended toward the palette so
/// the analyser belongs to the video's colour world instead of fighting it.
vec3 ledColour(float v) {
  vec3 c = mix(vec3(0.12, 0.95, 0.34), vec3(1.00, 0.74, 0.10), smoothstep(0.52, 0.74, v));
  c = mix(c, vec3(1.00, 0.17, 0.12), smoothstep(0.79, 0.92, v));
  return mix(c, palClamp(0.10 + 0.85 * v), p_tint);
}

/// Light emitted by the ladder at p. Nothing is occluded, so this is the whole
/// of the analyser and it can be sampled twice — once upright, once mirrored.
vec3 ladderLight(vec2 p, float aa) {
  float halfW = uAspect * 0.94;
  float bars = clamp(floor(p_bars + 0.5), 4.0, 64.0);
  float segs = clamp(floor(p_segments + 0.5), 4.0, 40.0);

  float bx = (p.x + halfW) / (2.0 * halfW) * bars;
  if (bx < -0.6 || bx > bars + 0.6) return vec3(0.0);

  float bar = clamp(floor(bx), 0.0, bars - 1.0);
  float pitch = 2.0 * halfW / bars;
  float cx = (bar + 0.5) * pitch - halfW;
  float x = (bar + 0.5) / bars;

  // The same shaping is applied to the level and to the cap, so the cap can
  // never end up drawn below the bar it belongs to.
  float n = valueNoise(vec2(bar * 1.7, uTime * 2.2)) - 0.5;
  float shape = max(0.0, 1.0 + p_detail * n * (1.1 + 1.5 * uOnset)) * mix(1.06, 0.86, x);

  float level = clamp(spectrumNow(x) * shape, 0.0, 1.0);
  float cap = clamp(spectrumPeak(x) * shape, 0.0, 1.0);

  float segH = (TOP - BASE) / segs;
  float sy = (p.y - BASE) / segH;
  float seg = floor(sy);

  vec3 emit = vec3(0.0);

  // --- the segment this pixel is in ---------------------------------------
  // `on` fades the topmost lit segment in rather than snapping it, which is what
  // gives the ladder its half-lit leading edge.
  float on = clamp(level * segs - seg, 0.0, 1.0);
  float inCol = step(0.0, seg) * step(seg, segs - 1.0);
  float segD = sdRoundBox2(vec2(p.x - cx, (fract(sy) - 0.5) * segH),
                           vec2(pitch * 0.34, segH * 0.30), segH * 0.12);
  emit += ledColour((seg + 0.5) / segs) * fill(segD, aa) * inCol * (0.05 + 1.25 * on);

  // --- glow off the lit part of the column --------------------------------
  // One halo for the whole lit stack rather than one per segment: this pixel can
  // only see its own cell, so per-segment bloom would stop at every cell edge.
  float litH = level * (TOP - BASE);
  float r = min(pitch * 0.2, max(litH * 0.5, 0.0));
  float glowD = sdRoundBox2(vec2(p.x - cx, p.y - (BASE + litH * 0.5)),
                            vec2(pitch * 0.34, litH * 0.5), r);
  emit += ledColour(level) * exp(-max(0.0, glowD) / 0.05)
          * 0.30 * p_glow * smoothstep(0.02, 0.12, level);

  // --- peak cap -----------------------------------------------------------
  float capSeg = floor(cap * segs);
  float capD = sdRoundBox2(vec2(p.x - cx, (sy - capSeg - 0.5) * segH),
                           vec2(pitch * 0.34, segH * 0.13), segH * 0.08);
  emit += gCap * fill(capD, aa) * 1.7
          * step(0.0, capSeg) * step(capSeg, segs - 1.0) * smoothstep(0.02, 0.10, cap);

  return emit;
}

void main() {
  vec2 p = centered(vUv, uAspect);
  float aa = pixel();

  gCap = mix(vec3(1.00, 0.97, 0.90), palClamp(0.99), p_tint * 0.7);

  // Card: near-black, with a slow palette wash behind the baseline so the panel
  // is a dark surface rather than a void.
  vec3 col = mix(vec3(0.030, 0.032, 0.040), vec3(0.008, 0.008, 0.012), sat(-p.y * 0.5 + 0.5));
  col += palClamp(0.20) * 0.04 * exp(-abs(p.y - BASE) * 1.5);

  col += ladderLight(p, aa);

  // Gloss. The same emitters mirrored about the baseline and dimmed, which is
  // all a reflection is once everything above it emits.
  float below = BASE - p.y;
  if (below > 0.0) {
    // A hair of horizontal wander, so it reads as polished rather than as a
    // second copy of the picture.
    float wob = sin(p.y * 85.0 + uTime * 1.4) * 0.004;
    col += ladderLight(vec2(p.x + wob, BASE + below), aa) * p_reflect * exp(-below * 3.4);
  }

  // The baseline the bars stand on.
  float bl = abs(p.y - BASE);
  col += mix(vec3(0.55), palClamp(0.75), p_tint)
         * (fill(bl - 0.0035, aa) * 0.45 + exp(-bl * 40.0) * 0.22);

  col *= 1.0 - 0.34 * pow(length(p * vec2(0.45, 0.75)), 2.6);
  col *= 0.95 + 0.12 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
