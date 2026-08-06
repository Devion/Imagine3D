#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"
#include "sdf.glsl"

// The analyser, stood up and walked into.
//
// The flat version was a good instrument and a poor scene: a ladder of LEDs on a
// baseline across the bottom third of the frame, a gloss under it, and nothing
// anywhere else. It read as a widget sitting on the video rather than as the
// video, which behind a band is exactly the wrong way round.
//
// Same instrument, marched. The bars are boxes on a floor that runs to the
// horizon, repeated forever in both axes by domain repetition, so one distance
// evaluation covers a field of thousands. The camera flies down it at bar
// height: the nearest columns are taller than the frame, the far ones converge
// on a vanishing point, and the floor underneath reflects the lot.
//
// About the depth axis. A real 3D analyser puts *time* into it - each row behind
// the front one is the spectrum a moment ago. This analysis has no history to
// draw on: the six band followers are uniforms at the current instant and
// nothing stores what they were. Rather than invent a past, the rows carry the
// present reading with a travelling phase, so the field ripples away from the
// camera as a wave. It is the same measurement everywhere, which is the honest
// thing to show, and it moves the way a history would.

const float PITCH = 0.62;    // spacing between bars, both axes
const float FAR = 46.0;

float gBars, gWidth, gHeight, gTime, gWave;

/// Frequency coordinate for the bar in column `ci`. Mirrored about the centre
/// line so the sub band runs down the middle of the canyon and air sits out at
/// the walls - the same convention the ring version uses, and the reason the
/// field breathes along one axis and glitters along the other.
float freqOf(float ci) {
  float u = fract((ci + 0.5) / gBars);
  return abs(1.0 - 2.0 * u);
}

/// Level and peak for the bar in cell (ci, cz).
void barLevels(float ci, float cz, out float lvl, out float pk) {
  float x = freqOf(ci);
  // The travelling phase. Rows further away are further round the wave, so the
  // field reads as motion away from the camera rather than as one solid ridge.
  float wave = 0.5 + 0.5 * sin(cz * PITCH * 0.7 - gTime * gWave);
  float shape = 0.30 + 0.95 * wave;

  // Per-bar deviation, so neighbouring columns are not identical samples of one
  // six-point curve.
  float n = valueNoise(vec2(ci * 1.9, cz * 0.7 + gTime * 0.8)) - 0.5;
  shape *= max(0.0, 1.0 + p_detail * n * (1.0 + 1.2 * uOnset));

  lvl = clamp(spectrumNow(x) * shape, 0.0, 1.4);
  pk = clamp(spectrumPeak(x) * shape, 0.0, 1.4);
}

float map(vec3 p) {
  vec2 cell = floor(p.xz / PITCH + 0.5);
  vec2 q = p.xz - cell * PITCH;

  float lvl, pk;
  barLevels(cell.x, cell.y, lvl, pk);

  float h = max(0.03, lvl * gHeight);
  float bar = sdBox(vec3(q.x, p.y - h * 0.5, q.y), vec3(gWidth, h * 0.5, gWidth));

  // The cap that holds the peak and slides down - the one part of a hi-fi meter
  // that says something the bar itself does not.
  float capY = max(0.06, pk * gHeight) + 0.07;
  float cap = sdBox(vec3(q.x, p.y - capY, q.y), vec3(gWidth * 1.2, 0.022, gWidth * 1.2));

  // Only the cell the point falls in is measured, which is the usual bound for a
  // repeated field and is an over-estimate here: a taller bar one cell over can
  // be nearer than the one directly below. Shortening every step by a third is
  // the cheap fix - a correct bound would mean evaluating four neighbours, and
  // this field is cheap to evaluate but not that cheap.
  return min(p.y, min(bar, cap)) * 0.66;
}

/// Colour of whatever the ray landed on at p. `eps` is how close to the floor
/// still counts as the floor, which has to grow with distance because so does
/// the marcher's hit tolerance.
vec3 shadeHit(vec3 p, vec3 n, vec3 rd, float eps) {
  vec2 cell = floor(p.xz / PITCH + 0.5);
  float lvl, pk;
  barLevels(cell.x, cell.y, lvl, pk);

  if (p.y < eps) {
    // Floor: dark, ruled, and mostly there to carry the reflection.
    vec2 g = abs(fract(p.xz / PITCH + 0.5) - 0.5);
    float line = smoothstep(0.055, 0.0, min(g.x, g.y));
    return palClamp(0.03) * 0.7 + palClamp(0.55) * line * 0.20;
  }

  float h = max(0.03, lvl * gHeight);
  float up = sat(p.y / max(h, 1e-3));

  // The ladder's own meaning: green at the bottom, amber, red at the top. Kept
  // as an option because it is what a meter means, not a decoration of it.
  vec3 native = up < 0.62 ? mix(vec3(0.10, 0.95, 0.30), vec3(0.35, 1.0, 0.20), up / 0.62)
              : up < 0.85 ? mix(vec3(0.95, 0.78, 0.10), vec3(1.0, 0.55, 0.05), (up - 0.62) / 0.23)
              : vec3(1.0, 0.16, 0.10);
  vec3 c = mix(native, palClamp(0.12 + 0.80 * up), p_tint);

  // Segment gaps, so a column is a stack of LEDs rather than a painted bar.
  float seg = fract(p.y * clamp(p_segments, 4.0, 40.0) / max(gHeight, 1e-3));
  c *= 0.45 + 0.75 * smoothstep(0.0, 0.16, seg) * smoothstep(1.0, 0.84, seg);

  // Cap slab reads white-hot.
  if (p.y > max(0.06, pk * gHeight) + 0.03) c = mix(vec3(1.0), palClamp(0.99), 0.5) * 1.6;

  // Emissive, but not flat: the faces facing the camera run brighter, which is
  // what keeps a box from reading as a sticker.
  c *= 0.62 + 0.55 * abs(dot(n, -rd));
  return c * (0.75 + 0.85 * lvl);
}

void main() {
  gBars = clamp(floor(p_bars + 0.5), 4.0, 64.0);
  gWidth = PITCH * 0.5 * clamp(p_thickness, 0.15, 0.95);
  gHeight = p_height;
  gTime = uTime;
  gWave = p_wave;

  vec2 uv = centered(vUv, uAspect);

  // Down among the bars, not above them. A camera looking down on the field
  // turns it back into a chart; a camera at bar height is inside a city.
  float travel = uTime * p_speed;
  vec3 ro = vec3(sin(uTime * 0.13) * 1.2, 0.55 + p_height * 0.42 + sin(uTime * 0.2) * 0.12, -travel);
  vec3 ta = ro + vec3(sin(uTime * 0.09) * 0.35, -0.18 + sin(uTime * 0.17) * 0.06, 1.0);
  mat3 cam = lookAt(ro, ta, sin(uTime * 0.07) * 0.06 + uBarPulse * 0.02);
  vec3 rd = normalize(cam * vec3(uv, 1.5 + 0.10 * uBeatPulse));

  // ---- sky ----------------------------------------------------------------
  // Night, not daylight. The bars are emitters and the whole read depends on
  // them being the brightest thing in the shot; a sky anywhere near their level
  // turns a lit canyon into an aerial photograph of an industrial estate.
  vec3 sky = mix(palClamp(0.26), palClamp(0.01), sat(rd.y * 1.8 + 0.15)) * 0.28;
  sky += palClamp(0.70) * exp(-abs(rd.y) * 5.0) * 0.16;              // horizon band
  sky += palClamp(0.85) * pow(max(0.0, rd.y), 6.0) * 0.06;
  vec3 col = sky;

  int steps;
  float t = raymarch(ro, rd, FAR, 96, steps);

  if (t < FAR) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, 0.004);
    float eps = max(0.02, 0.006 * t);
    vec3 c = shadeHit(p, n, rd, eps);

    // Floor reflection. A second, short march is what makes a lit field over a
    // polished plane read as a room rather than as two unrelated pictures.
    if (p.y < eps) {
      vec3 r = reflect(rd, vec3(0.0, 1.0, 0.0));
      float rt = 0.05;
      for (int i = 0; i < 40; i++) {
        float d = map(p + r * rt);
        if (d < 0.004 || rt > 14.0) break;
        rt += d * 0.9;
      }
      vec3 refl = sky;
      if (rt <= 14.0) {
        vec3 rp = p + r * rt;
        refl = shadeHit(rp, calcNormal(rp, 0.006), r, 0.02) * exp(-rt * 0.10);
      }
      // Grazing angles see the reflection, steep ones see the surface.
      c += refl * p_reflect * pow(1.0 - abs(rd.y), 2.0) * 1.2;
    }

    c *= 0.30 + 0.70 * ambientOcclusion(p, n);
    col = mix(c, sky, smoothstep(FAR * 0.25, FAR * 0.9, t));
  }

  // Glow gathered from rays that nearly grazed something - the haze a field of
  // emitters throws into the air around it.
  col += palClamp(0.85) * pow(1.0 - float(steps) / 96.0, 5.0) * 0.16 * p_glow;

  col *= 0.94 + 0.20 * uBeatPulse;
  col = col / (1.0 + col * 0.30);
  fragColor = vec4(max(col, 0.0), 1.0);
}
