#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"

// The spectrum ring, repeated down a tunnel and flown through.
//
// One ring in the middle of the frame is the shape every music player draws
// around its artwork, and that is the problem with it here: it is a widget. It
// occupies a disc in the centre, the corners never light up, and there is
// nothing for the eye to travel along - which behind a band is most of what
// makes a visual feel like a place rather than a badge.
//
// The instrument is unchanged. Bars are still straight radial capsules rather
// than polar wedges - a wedge computed in (angle, radius) space is wider at its
// tip than at its root and reads as a pie chart, where a capsule laid along its
// own direction vector is the same width all the way out and takes a round cap
// for free. The frequency axis is still mirrored across the circle, so the low
// end pumps on one axis of the frame and the top end glitters at right angles
// to it.
//
// What is new is that there are twenty of them, at twenty depths, and the camera
// is moving. Each ring is scaled by F/z, so the nearest sweeps past the corners
// of the frame while the furthest converges on a point. Rings are drawn
// additively and need no sorting: they are light, and light does not occlude.
// Which is also why this costs about what one ring did - there is no march, and
// a ring whose projected annulus misses the pixel is rejected in two compares.

const float PITCHZ = 0.85;    // world spacing between rings
const float FOCAL = 1.25;

vec3 gCap;

/// Light emitted by one ring at screen radius/angle, already scaled to depth.
vec3 ringLight(vec2 p, float rad, float ang, float scale, float roll,
               float id, float aa) {
  float bars = clamp(floor(p_bars + 0.5), 8.0, 160.0);
  float R0 = clamp(p_inner, 0.08, 0.7);
  float reach = clamp(p_reach, 0.02, 1.2);

  float w = TAU / bars * R0 * 0.33;
  float root = R0 + w;

  // Cheap rejection: the whole ring lives in an annulus, and most pixels are
  // outside it. Two compares throw the ring out before any trigonometry.
  float lo = (root - w * 2.0) * scale;
  float hi = (root + reach * 1.45 + w * 3.0) * scale;
  if (rad < lo || rad > hi) return vec3(0.0);

  // Index in the rotating frame, so a bar keeps its band as the ring turns.
  // Wrapped before it is floored: without the fract() the index runs off past a
  // full turn and the whole far side of the ring pins to the top band.
  float sect = fract((ang + roll) / TAU + 0.5);
  float bar = floor(sect * bars);
  float ca = (bar + 0.5) / bars * TAU - PI - roll;

  float u = (bar + 0.5) / bars;
  float x = abs(1.0 - 2.0 * u);     // mirrored: sub at one pole, air at the seam

  float n = valueNoise(vec2(bar * 1.9, uTime * 2.0 + id)) - 0.5;
  float shape = max(0.0, 1.0 + p_detail * n * (1.0 + 1.4 * uOnset));

  float level = clamp(spectrumNow(x) * shape, 0.0, 1.0);
  float cap = clamp(spectrumPeak(x) * shape, 0.0, 1.0);

  // Into the bar's own frame: y runs outward, x across it. Everything from here
  // down is in screen units, so one scale factor covers the whole ring.
  vec2 dir = vec2(cos(ca), sin(ca));
  vec2 q = vec2(dot(p, vec2(-dir.y, dir.x)), dot(p, dir));

  float sw = w * scale;
  float sroot = root * scale;
  float len = max(0.0, level * reach) * scale;

  float d = sdSegment2(q, vec2(0.0, sroot), vec2(0.0, sroot + len)) - sw;
  vec3 c = palClamp(0.14 + 0.78 * clamp((q.y - sroot) / max(0.05, reach * scale), 0.0, 1.0));

  vec3 emit = c * fill(d, aa) * 1.15;
  emit += c * exp(-max(0.0, d) / max(1e-4, sw * 1.7)) * 0.45 * p_glow;

  // Peak cap: a tangential dash floating just past the bar's tip.
  float capR = sroot + max(0.0, cap * reach) * scale + sw * 1.6;
  float capD = sdRoundBox2(q - vec2(0.0, capR), vec2(sw * 1.15, sw * 0.34), sw * 0.3);
  emit += gCap * fill(capD, aa) * 1.6 * smoothstep(0.02, 0.10, cap);

  // The dial the bars measure against, so a ring never ends in mid-air.
  float RD = (R0 + reach + 0.07) * scale;
  emit += palClamp(0.45) * fill(abs(rad - RD) - 0.0022 * max(scale, 0.4), aa) * 0.30;

  return emit;
}

void main() {
  vec2 p = centered(vUv, uAspect);
  float aa = pixel();

  // A slow drift of the tunnel axis, so the vanishing point is not nailed to
  // the middle of the frame for a whole scene.
  p -= vec2(sin(uTime * 0.11), cos(uTime * 0.09)) * p_drift;

  float rad = length(p);
  float ang = atan(p.y, p.x);

  gCap = mix(vec3(1.0), palClamp(0.99), 0.6);

  float travel = uTime * p_speed;

  // --- the tunnel the rings hang in ---------------------------------------
  vec3 col = palClamp(0.10) * (0.55 + 0.45 * exp(-rad * 0.9));
  col += palClamp(0.38) * fbm(p * 1.6 + vec2(0.0, travel * 0.10), 4, 2.0, 0.5) * 0.16;
  // Wall of the tunnel, brightening toward the edges of the frame - the surface
  // the rings are passing through rather than the void they used to hang in.
  col += palClamp(0.30) * smoothstep(0.3, 1.5, rad) * 0.14;

  // The core, seen down the throat rather than sat in the middle of the picture:
  // a pool of stirred light the low end pumps, converging with the rings.
  float pool = fbm(p * 5.0 + vec2(uTime * 0.12, uTime * 0.2), 4, 2.0, 0.5);
  col += palClamp(0.22 + 0.55 * pool) * exp(-rad * 3.6)
         * (0.35 + 0.95 * uBass + 0.60 * uBeatPulse) * p_core;

  // Pressure rings leaving the core on the beat and running out past the frame.
  for (int i = 0; i < 3; i++) {
    float age = fract(uBar + float(i) / 3.0);
    float d = abs(rad - age * 2.4);
    col += palClamp(0.85) * exp(-d * 26.0) * (1.0 - age) * (1.0 - age) * 0.30 * p_glow;
  }

  // --- the stack of rings --------------------------------------------------
  int rings = int(clamp(p_rings, 3.0, 20.0));

  for (int k = 0; k < 20; k++) {
    if (k >= rings) break;
    float fk = float(k);

    // Depth recycles, so the flight never ends and no ring is ever born or dies
    // where it can be seen doing it.
    float z = 0.30 + PITCHZ * (fk + fract(-travel / PITCHZ));
    float id = floor(travel / PITCHZ) + fk;
    float scale = FOCAL / z;

    float roll = uTime * p_spin + id * p_twist;

    // Depth grading. The nearest ring is hot and huge, the furthest is a faint
    // suggestion, so the tunnel has no back wall.
    float dim = exp(-z * 0.11) * smoothstep(0.0, 1.1, z);

    col += ringLight(p, rad, ang, scale, roll, id, aa) * dim;
  }

  col *= 0.95 + 0.18 * uBeatPulse;
  // Additive light down a tunnel has no ceiling; roll it off rather than clip.
  col = col / (1.0 + col * 0.35);
  fragColor = vec4(max(col, 0.0), 1.0);
}
