#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"
#include "sdf.glsl"

// A machine corridor: two walls racked floor to ceiling with moving-coil VU
// meters, flown down at head height.
//
// It used to be one rack unit turning in a dark room. Every word below about how
// the meter is drawn still applies to it — that part was right — but one object
// in the middle of a black frame lights about a quarter of the screen, and a
// swing that hides the faces at both ends of its travel spends half the scene
// showing the edge of a box. Behind a band that is a long time to look at
// nothing. The unit is now repeated up the walls and away down the corridor by
// domain repetition, so a single distance evaluation still covers the whole
// wall, and the camera flies between them: the nearest panels overrun the top
// and bottom of the frame, the far ones converge on a lit vanishing point, and
// every needle on screen is reading the music.
//
// The two meters are not left and right. The analysis is mono, so there is no
// stereo to show and pretending otherwise would mean driving two needles from
// one number and watching them move as one object. Each reads a different half
// of the spectrum instead — a real reading, and one that behaves the way a
// stereo pair does: the two agree about the shape of a section and disagree
// constantly about the detail. Which bands feed which meter is a parameter.
//
// The chassis is marched; the meter faces are *drawn*, in the panel's own
// coordinates, at whatever point the ray landed. That split is the whole trick.
// Modelling a printed scale as geometry would cost a hundred primitives and
// still alias; drawing it as a procedural texture on a marched surface gives it
// real perspective, real reflections in the glass over it and real depth of
// field from the camera, for the price of one texture evaluation on the pixels
// that actually see the card.
//
// The needle deflects linearly in the level it is given, because the six band
// followers are already normalised in the decibel domain (see BandEnergy.cs).
// The printed scale is linear to match — the crowded low end of a real VU face
// is that meter's way of showing dB on a needle that moves with voltage, and
// copying the look without the cause would put every mark in the wrong place.

const float PIVOT_Y = -0.95;   // pivot, below the visible card
const float ARC_R   = 1.15;    // radius of the printed scale
const float SWEEP   = 0.72;    // half the needle's travel, in radians
const float RED_AT  = 0.78;    // where the red zone starts, along the scale

// Card half-size in world units, and in the local units the face is drawn in.
const vec2 CARD = vec2(0.50, 0.297);
const float CARD_SCALE = 0.96 / 0.50;   // world -> card

// The corridor. Periods must clear twice the unit's half-extents or neighbouring
// racks intersect and the repeated distance stops being a bound on anything.
const float WALL = 2.75;   // half-width of the corridor
const float PZ   = 3.05;   // rack spacing along it   (unit is 2.64 wide)
const float PY   = 1.06;   // rack spacing up the wall (unit is 0.92 tall)

float gWall;               // how far the racks lean in, 0 = flat walls
vec3 gFace, gInk, gRed, gLamp;

float sdRoundBox3(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }

/// World space into the local frame of whichever rack unit is nearest.
///
/// Three isometries, so the result is still a valid distance: mirror about the
/// corridor axis to get two walls out of one, swap axes so the unit's +z (the
/// face its wells are cut into) points inward at the camera, then fold along the
/// corridor and up the wall. What comes back out is one unit standing at the
/// origin, exactly as the rest of this shader was written to expect.
///
/// The panel's own left-right axis is flipped with the wall, which is the part
/// that is easy to get wrong. Mirroring in x and then reading the card along a
/// *shared* +z leaves one of the two walls handed the other way round: its scale
/// is printed backwards, its red zone sits at the quiet end and its needle falls
/// as the music gets louder. Nobody notices while only one wall is in frame.
vec3 toUnit(vec3 p) {
  float ax = abs(p.x);
  float wall = p.x < 0.0 ? -1.0 : 1.0;

  vec3 q;
  q.x = p.z * wall;        // along the corridor -> across the panel
  q.y = p.y;
  q.z = WALL - ax;         // inward from the wall -> out of the panel face

  // A slow lean, so the wall breathes rather than being a flat plane of boxes.
  q.z += gWall * sin(p.z * 0.21 + uTime * 0.4) * 0.10;

  q.x = mod(q.x + PZ * 0.5, PZ) - PZ * 0.5;
  q.y = mod(q.y + PY * 0.5, PY) - PY * 0.5;
  return q;
}

/// Which rack this is, as a number in 0..1. Used to detune one unit from the
/// next: a wall of needles all reading exactly the same value moves as one
/// object, which is the thing the two meters on a single panel already avoid.
float unitId(vec3 p) {
  return hash12(vec2(floor(p.z / PZ + 0.5), floor(p.y / PY + 0.5)) + step(0.0, p.x) * 37.0);
}

/// The chassis: a rounded slab with two rectangular wells cut into its face.
float mapUnit(vec3 q) {
  float body = sdRoundBox3(q, vec3(1.32, 0.46, 0.135), 0.035);

  // Mirrored, so one evaluation carves both wells.
  vec3 w = q;
  w.x = abs(w.x) - 0.63;
  float well = sdRoundBox3(w - vec3(0.0, 0.0, 0.135), vec3(0.53, 0.325, 0.062), 0.018);

  // A shallow groove along the panel, which is most of what says "machined".
  float groove = sdRoundBox3(q - vec3(0.0, 0.0, 0.135), vec3(1.40, 0.012, 0.02), 0.008);

  return max(max(body, -well), -groove);
}

float map(vec3 p) {
  return mapUnit(toUnit(p));
}

// ---------------------------------------------------------------- the card

/// The two letters printed on every VU meter, in a box about 2 x 1.
float glyphVU(vec2 p, float aa) {
  vec2 a = p - vec2(-0.5, 0.0);
  float v = min(sdSegment2(a, vec2(-0.26, 0.42), vec2(0.0, -0.42)),
                sdSegment2(a, vec2( 0.26, 0.42), vec2(0.0, -0.42)));

  // The U is two uprights and a half-circle, the circle cut by pushing the
  // distance away above the join where the uprights cover the seam anyway.
  vec2 b = p - vec2(0.5, 0.0);
  float u = min(sdSegment2(b, vec2(-0.24, 0.42), vec2(-0.24, -0.10)),
                sdSegment2(b, vec2( 0.24, 0.42), vec2( 0.24, -0.10)));
  u = min(u, abs(length(b - vec2(0.0, -0.10)) - 0.24) + step(-0.10, b.y));

  return fill(min(v, u) - 0.075, aa);
}

/// The lit card, drawn in card units: it spans +-0.96 by +-0.57.
vec3 meterFace(vec2 q, float level, float peak, float aa) {
  vec3 f = gFace;

  // Backlight: a lamp behind the card, hottest just under the scale, so the
  // face is brightest where the needle is read and falls off at the corners.
  float lamp = exp(-dot(q - vec2(0.0, 0.10), q - vec2(0.0, 0.10)) * 1.7);
  f *= 0.62 + 0.55 * lamp * p_glow;
  f = mix(f, gLamp, 0.30 * lamp * p_glow);
  f *= 0.94 + 0.09 * valueNoise(q * 90.0);      // card stock

  vec2 r = q - vec2(0.0, PIVOT_Y);
  float ang = atan(r.x, r.y);
  float rad = length(r);
  float sweepM = step(abs(ang), SWEEP + 0.004);
  float u = (ang + SWEEP) / (2.0 * SWEEP);      // 0..1 along the scale
  vec3 ink = mix(gInk, gRed, step(RED_AT, u));

  float scaleM = stroke(sdArc2(r, ARC_R, SWEEP), 0.006, aa);

  // Ticks hang inward from the arc: 20 divisions, every fifth one long. Drawn as
  // a box in (arc length, radius) space, so they keep their shape all the way to
  // the ends of the sweep.
  float div = u * 20.0;
  float nearest = clamp(floor(div + 0.5), 0.0, 20.0);
  float major = 1.0 - step(0.5, mod(nearest, 5.0));
  float tickLen = mix(0.045, 0.090, major);
  vec2 tq = vec2((div - nearest) * (2.0 * SWEEP / 20.0) * ARC_R, rad - ARC_R + tickLen * 0.5);
  scaleM = max(scaleM, fill(sdBox2(tq, vec2(mix(0.006, 0.011, major), tickLen * 0.5)), aa) * sweepM);

  f = mix(f, ink, scaleM);

  // The red zone is a bolder arc outside the scale line, the way it is printed.
  f = mix(f, gRed, fill(abs(rad - (ARC_R + 0.045)) - 0.014, aa)
                   * sweepM * smoothstep(RED_AT - 0.004, RED_AT + 0.004, u));

  f = mix(f, gInk, glyphVU((q - vec2(0.0, -0.34)) / 0.10, aa / 0.10) * 0.85);

  // Peak lamp.
  vec2 lp = q - vec2(0.70, -0.36);
  float lit = smoothstep(RED_AT - 0.05, RED_AT + 0.03, peak);
  vec3 lampCol = mix(vec3(0.22, 0.07, 0.06), gRed * 1.7 + vec3(0.30), lit);
  f = mix(f, lampCol, fill(length(lp) - 0.055, aa));
  f += lampCol * lit * exp(-length(lp) * 13.0) * 0.55;

  // Needle. A moving-coil needle is a stiff root and a hair at the tip, and that
  // taper is most of what stops it reading as a drawn line.
  vec2 hub = vec2(0.0, PIVOT_Y);
  vec2 tip = hub + vec2(sin(mix(-SWEEP, SWEEP, clamp(level, 0.0, 1.0))),
                        cos(mix(-SWEEP, SWEEP, clamp(level, 0.0, 1.0)))) * (ARC_R - 0.015);
  float along = clamp(distance(q, hub) / ARC_R, 0.0, 1.0);
  float nw = mix(0.017, 0.0035, along * along);

  f *= 1.0 - 0.35 * fill(sdSegment2(q - vec2(0.014, -0.014), hub, tip) - nw * 1.3, aa);
  f = mix(f, gInk * 0.6, fill(sdSegment2(q, hub, tip) - nw, aa));

  // Vignette from the well's own walls.
  f *= 1.0 - 0.28 * smoothstep(0.55, 1.0, max(abs(q.x) / 0.96, abs(q.y) / 0.57));
  return f;
}

// ---------------------------------------------------------------- lighting

const vec3 KEY = vec3(-0.4193, 0.7639, 0.4892);   // normalize(-0.45, 0.82, 0.525)

/// A small studio: gradient, a broad softbox overhead, a coloured kicker behind.
/// Metal here is lit mostly by reflecting this rather than by a lambert term,
/// which is what makes a brushed panel read as metal instead of grey plastic —
/// but the softbox is deliberately wide. A tight one looks better on a curved
/// object and abandons a flat panel completely, because every point on it
/// reflects almost the same direction and so either all of it catches the light
/// or none of it does.
vec3 env(vec3 d) {
  vec3 c = mix(palClamp(0.04) * 0.9, palClamp(0.34) * 1.1, d.y * 0.5 + 0.5);
  c += vec3(1.0, 0.97, 0.92) * pow(max(0.0, dot(d, KEY)), 3.0) * 1.5;
  c += pal(0.16) * pow(max(0.0, dot(d, normalize(vec3(0.80, 0.18, -0.55)))), 4.0) * 1.1;
  c += palClamp(0.60) * pow(max(0.0, -d.y), 3.0) * 0.25;
  return c;
}

/// Is this point on the bottom of a meter well, and if so where on the card?
bool onCard(vec3 q, out vec2 card, out float side) {
  vec3 w = q;
  w.x = abs(w.x) - 0.63;
  card = w.xy * CARD_SCALE;
  side = step(0.0, q.x);
  return q.z > 0.055 && abs(w.x) < CARD.x && abs(w.y) < CARD.y;
}

/// Shade the chassis at a hit. `emissive` comes back separately so the glass
/// over the card and the bloom around it can both use it.
vec3 shadeUnit(vec3 q, vec3 n, vec3 rd, float aa, float id, out vec3 emissive) {
  emissive = vec3(0.0);

  vec2 card;
  float side;
  if (onCard(q, card, side)) {
    // Detune this rack from its neighbours. Each unit sits a little hotter or
    // colder on the same reading and lags it slightly, so a wall of them ripples
    // the way a room full of meters does instead of moving as one dial.
    float trim = 0.72 + 0.62 * id;
    float lag = 1.0 - 0.22 * fract(id * 7.3) * (1.0 - uRms);

    vec3 lit = meterFace(card, (side < 0.5 ? p_left : p_right) * trim * lag,
                               (side < 0.5 ? p_leftPeak : p_rightPeak) * trim,
                               aa * CARD_SCALE);
    // Glass over the well. Grazing angles reflect the room hard, which is what
    // hides a meter face when the unit turns away — and is the single strongest
    // cue that there is a pane in front of it.
    float fres = pow(1.0 - abs(dot(n, rd)), 4.0);
    vec3 glass = env(reflect(rd, n)) * (0.05 + 0.95 * fres);
    emissive = lit;
    return lit * (1.0 - fres * 0.7) + glass;
  }

  // Brushed aluminium. The grain runs across the panel, so the highlight smears
  // along x and stays tight in y.
  vec3 nn = normalize(n + vec3(0.0, valueNoise(q.xy * vec2(3.0, 240.0)) - 0.5, 0.0) * 0.10);
  vec3 refl = reflect(rd, nn);
  float fres = 0.06 + 0.94 * pow(1.0 - abs(dot(nn, rd)), 5.0);

  vec3 base = mix(vec3(0.16, 0.165, 0.18), palClamp(0.10), 0.4 * p_tint);
  vec3 col = base * (0.30 + 0.85 * max(0.0, dot(nn, KEY)));
  col += env(refl) * mix(0.30, 1.0, fres) * 0.55;
  // A machined edge catches the room all the way round, and that bright outline
  // is most of what separates the chassis from the dark it is sitting in.
  col += palClamp(0.85) * pow(1.0 - abs(dot(n, rd)), 3.0) * 0.30;
  return col;
}

void main() {
  gFace = mix(vec3(0.93, 0.89, 0.74), palClamp(0.88), p_tint);
  gLamp = mix(vec3(1.00, 0.78, 0.42), pal(0.14), p_tint);
  gInk  = mix(vec3(0.07, 0.06, 0.06), palClamp(0.02), p_tint * 0.6);
  gRed  = mix(vec3(0.86, 0.13, 0.10), pal(0.03), p_tint * 0.5);

  gWall = p_lean;

  vec2 uv = centered(vUv, uAspect);
  // 68 degrees across a 16:9 frame. Wider than this and a corridor this narrow
  // stops being a corridor: at 90 the walls entered the frame a metre and a half
  // ahead of the camera, so most of the picture was one wall seen from arm's
  // length and the vanishing point had nowhere left to sit.
  //
  // Set against the frame's width rather than its height, which is the only
  // thing that carries over to a tall crop. The corridor has walls and no floor
  // or ceiling, so a ray that leaves the frame's middle vertically never hits
  // anything: hold the focal length fixed and 9:16 - which sees a third of the
  // width - is a slot of meters down each edge and empty air between them. The
  // floor is where widening stops buying wall and starts bending the near
  // panels.
  float F = max(1.30, 2.55 * uAspect / 1.7778) + 0.16 * uBeatPulse;

  // Down the middle of the corridor, half a rack above the row it is flying
  // past, drifting a little between the two walls. Looking *along* it rather
  // than at any one unit: what makes this a place instead of a product shot is
  // that the panels arrive and leave.
  //
  // The eye stays near the middle and the pan stays small on purpose. Both used
  // to be several times this, and a corridor flight only reads as a flight while
  // the point everything expands out of is in the frame — swing the camera at a
  // wall it is a metre from and the near panels cover the middle of the picture,
  // the vanishing point goes off the side, and what is left is a wall of
  // identical meters sliding sideways. A repeating lattice sliding sideways has
  // no direction in it at all: it reads as easily as travelling backwards.
  //
  // The height is picked against the rack grid rather than in the abstract.
  // PY * 0.5 puts the eye on the seam between two rows, so the row below is seen
  // slightly from above and the row over it slightly from below, and the wall
  // has a horizon in it. Level with a row centre — where this used to sit — the
  // nearest face is square-on at eye height and blocks what is behind it.
  float travel = uTime * p_travel;
  vec3 ro = vec3(sin(uTime * 0.13) * WALL * 0.11,
                 PY * 0.5 + sin(uTime * 0.09) * 0.16,
                 travel);
  vec3 ta = ro + vec3(sin(uTime * 0.07) * 0.10, sin(uTime * 0.11) * 0.05, 1.0);
  mat3 cam = lookAt(ro, ta, sin(uTime * 0.05) * 0.05 + uBarPulse * 0.02);
  vec3 rd = normalize(cam * vec3(uv, F));

  const float FAR = 26.0;

  // Primary march. Written out rather than using raymarch() so the haze around
  // the lit wells can be gathered on the way in.
  float t = 0.0, glow = 0.0;
  for (int i = 0; i < 128; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);

    // Proximity to the two wells, accumulated as the ray passes them. This is
    // the bloom: a lit card in a dark room throws light into the air in front of
    // it, and there is no cheaper way to say so than to gather it here.
    vec3 q = toUnit(p);
    q.x = abs(q.x) - 0.63;
    glow += 0.05 / (1.0 + 14.0 * dot(q, q)) * min(d, 0.1) * exp(-t * 0.10);

    if (d < 0.0006 * t || t > FAR) break;
    t += d * 0.85;
  }

  vec3 col;
  vec3 emissive = vec3(0.0);

  if (t < FAR) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, 0.0012);

    // One pixel, measured on the surface it landed on. Grazing hits cover more
    // ground per pixel, and a printed scale that ignores that aliases at exactly
    // the angles this camera spends most of its time at.
    float aa = max(0.0008, t * (2.0 / uResolution.y) / F / max(0.12, abs(dot(n, rd))));

    col = shadeUnit(toUnit(p), n, rd, aa, unitId(p), emissive);
    float ao = ambientOcclusion(p, n);
    col *= 0.35 + 0.65 * ao;
    col += emissive * 0.65 * ao;

    // The far end of the corridor is atmosphere, not a wall, so the depth has
    // somewhere to go instead of stopping.
    col = mix(col, palClamp(0.06) * 0.7, smoothstep(5.0, FAR * 0.85, t));
  } else {
    // Straight down the corridor: nothing is hit, and what is there is the light
    // at the end of it.
    col = env(rd) * 0.35;
    col += palClamp(0.55) * exp(-length(uv * vec2(0.55, 1.0)) * 1.6) * 0.22;
  }

  // The lamp glow, and a lit haze filling the length of the corridor.
  col += mix(gLamp, palClamp(0.9), 0.4) * glow * 2.6 * p_glow;
  col += palClamp(0.40) * exp(-length(uv) * 1.5) * 0.10 * p_glow;

  col *= 0.94 + 0.14 * uBeatPulse;
  // Barely a vignette. The corridor already darkens with depth, and anything
  // heavier here would put the two things this effect is now about - the near
  // panels at the top and bottom of the frame - into shadow.
  col *= 1.0 - 0.14 * pow(clamp(length(uv * vec2(0.4, 0.6)), 0.0, 1.0), 3.0);
  fragColor = vec4(max(col, 0.0), 1.0);
}
