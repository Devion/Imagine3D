#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"
#include "sdf.glsl"

// A rack unit turning slowly in a dark room, with two moving-coil VU meters
// recessed into its front panel behind glass.
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

float gYaw, gRoll, gPitch;
vec3 gFace, gInk, gRed, gLamp;

float sdRoundBox3(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }

/// Into the unit's own frame. The chassis turns; the floor under it does not.
vec3 toUnit(vec3 p) {
  p.y -= 0.06 * sin(uTime * 0.37);
  p.xz *= rot(gYaw);
  p.xy *= rot(gRoll);
  p.yz *= rot(gPitch);
  return p;
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
  return min(mapUnit(toUnit(p)), p.y + 0.62);
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
vec3 shadeUnit(vec3 q, vec3 n, vec3 rd, float aa, out vec3 emissive) {
  emissive = vec3(0.0);

  vec2 card;
  float side;
  if (onCard(q, card, side)) {
    vec3 lit = meterFace(card, side < 0.5 ? p_left : p_right,
                               side < 0.5 ? p_leftPeak : p_rightPeak, aa * CARD_SCALE);
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

  // The unit swings rather than spinning: a full turn would hide both faces for
  // half of every scene. A wide swing shows the panel edge-on at the ends, which
  // is where the depth of the wells and the thickness of the glass read best.
  gYaw = sin(uTime * 0.19) * p_orbit;
  gRoll = sin(uTime * 0.13) * 0.10 + uBarPulse * 0.03;
  gPitch = 0.10 + sin(uTime * 0.11) * 0.07;

  vec2 uv = centered(vUv, uAspect);
  float F = 1.75 + 0.12 * uBeatPulse;

  // In front of the panel, not behind it: the wells are cut into the +z face, so
  // the camera has to be on that side or the whole effect is the back of a box.
  vec3 ro = vec3(sin(uTime * 0.07) * 0.16, 0.16 + sin(uTime * 0.09) * 0.06, 2.15);
  mat3 cam = lookAt(ro, vec3(0.0, -0.02, 0.0), sin(uTime * 0.05) * 0.04);
  vec3 rd = normalize(cam * vec3(uv, F));

  // Primary march. Written out rather than using raymarch() so the haze around
  // the lit wells can be gathered on the way in.
  float t = 0.0, glow = 0.0;
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    float d = map(p);

    // Proximity to the two wells, accumulated as the ray passes them. This is
    // the bloom: a lit card in a dark room throws light into the air in front of
    // it, and there is no cheaper way to say so than to gather it here.
    vec3 q = toUnit(p);
    q.x = abs(q.x) - 0.63;
    glow += 0.05 / (1.0 + 14.0 * dot(q, q)) * min(d, 0.1);

    if (d < 0.0006 * t || t > 12.0) break;
    t += d * 0.85;
  }

  vec3 col;
  vec3 emissive = vec3(0.0);

  if (t < 12.0) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, 0.0012);

    // One pixel, measured on the surface it landed on. Grazing hits cover more
    // ground per pixel, and a printed scale that ignores that aliases at exactly
    // the angles this camera spends most of its time at.
    float aa = max(0.0008, t * (2.0 / uResolution.y) / F / max(0.12, abs(dot(n, rd))));

    if (p.y < -0.615) {
      // Floor: dark, polished, ruled. The reflection is a second march against
      // the chassis alone — the floor cannot see itself, and letting it try
      // costs a hundred steps to render a black plane.
      vec3 r = reflect(rd, vec3(0.0, 1.0, 0.0));
      vec3 refl = env(r) * 0.35;

      float rt = 0.02;
      for (int i = 0; i < 48; i++) {
        float d = mapUnit(toUnit(p + r * rt));
        if (d < 0.002 || rt > 7.0) break;
        rt += d * 0.9;
      }
      if (rt <= 7.0) {
        vec3 rp = p + r * rt;
        vec3 rq = toUnit(rp);
        vec3 rn = calcNormal(rp, 0.003);
        vec3 e;
        refl = shadeUnit(rq, rn, r, 0.006, e) * 0.55;
      }

      float grid = min(abs(fract(p.x * 0.7 + 0.5) - 0.5), abs(fract(p.z * 0.7 + 0.5) - 0.5));
      vec3 floorCol = palClamp(0.05) * 0.55;
      floorCol += palClamp(0.60) * smoothstep(clamp(0.006 * t, 0.006, 0.4), 0.0, grid) * 0.22;
      // Grazing angles see the reflection, steep ones see the surface. Without
      // the falloff a polished floor is just a second copy of the object.
      floorCol += refl * pow(1.0 - abs(dot(rd, vec3(0.0, 1.0, 0.0))), 2.0) * 1.1;
      floorCol *= 0.30 + 0.70 * softShadow(p + vec3(0.0, 0.002, 0.0), KEY, 0.05, 4.0, 12.0);
      floorCol *= exp(-max(0.0, t - 2.0) * 0.18);
      col = floorCol;
    } else {
      col = shadeUnit(toUnit(p), n, rd, aa, emissive);
      col *= 0.35 + 0.65 * ambientOcclusion(p, n);
      col += emissive * 0.65 * ambientOcclusion(p, n);
    }

    col = mix(col, palClamp(0.02) * 0.6, smoothstep(3.0, 11.0, t));
  } else {
    // The room behind it.
    col = env(rd) * 0.5;
    col += palClamp(0.40) * exp(-length(uv * vec2(0.6, 1.0)) * 1.4) * 0.08;
  }

  col += mix(gLamp, palClamp(0.9), 0.4) * glow * 2.2 * p_glow;

  col *= 0.94 + 0.14 * uBeatPulse;
  col *= 1.0 - 0.34 * pow(clamp(length(uv * vec2(0.5, 0.8)), 0.0, 1.0), 2.4);
  fragColor = vec4(max(col, 0.0), 1.0);
}
