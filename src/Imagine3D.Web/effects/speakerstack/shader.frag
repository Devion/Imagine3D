#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"
#include "sdf.glsl"

// A canyon walled on both sides with speaker drivers, flown down the middle.
//
// The wall is a height field, not an assembly of primitives: one profile of the
// radius gives the dust cap, the cone dish, the surround roll and the basket,
// and the distance field is that profile subtracted from a plane. A driver then
// costs about as much as a plane — which is what makes a canyon of several
// hundred of them affordable, with every cone taking its own light, its own
// specular on the cap and its own excursion.
//
// Subtracting a height field from a plane over-states the distance wherever the
// surface is steep, and an over-stated distance is how a sphere-tracer walks
// through a wall. The profile is shaped so its slope stays under about 1.4 and
// every step is taken at half the reported distance, which is the cheapest way
// to make it a bound again.
//
// Rows are tuned like a real stack: the sub and bass bands along the floor on
// the big cones, air at the top on the small ones. What you fly through is the
// music divided up over the walls, not every cone doing the same thing at once.
//
// Excursion is the envelope, not the signal. A 40 Hz cone moving at 40 Hz is a
// blur and reads as nothing; these sit out at their band's level and then ring
// at a few hertz after a hit, which is what a driver being hit looks like even
// though it is not what it does.

const float WALL = 2.15;    // half the width of the canyon
const float FLOOR_Y = -1.75;

float gPitch, gThrow;

/// Front surface of a driver at radius r, in units of the driver's own radius,
/// with the moving assembly pushed out by z. Smooth throughout: the normal is
/// differenced from this, and a step() anywhere would come back as a ring of
/// white spikes.
float driverProfile(float r, float z) {
  float moving = 1.0 - smoothstep(0.74, 0.94, r);

  float h = 0.30 * exp(-(r / 0.26) * (r / 0.26));                              // dust cap
  h -= 0.20 * smoothstep(0.20, 0.70, r) * (1.0 - smoothstep(0.74, 0.90, r));   // cone dish
  h += 0.14 * exp(-pow((r - 0.82) / 0.090, 2.0));                              // surround roll
  h -= 0.09 * smoothstep(0.94, 1.02, r);                                       // basket, set back

  return h + z * moving;
}

/// Which cell of which wall p belongs to, how far out from that driver's centre
/// it is, and how far the cone there is standing out into the canyon.
float wallBulge(vec3 p, out vec2 cell, out float r, out float band, out float level) {
  float P = gPitch;

  // The two walls are staggered by half a cell, so flying down the middle does
  // not look like one wall mirrored.
  vec2 s = vec2(p.z + step(0.0, p.x) * P * 0.5, p.y);
  cell = floor(s / P);
  vec2 q = s - (cell + 0.5) * P;

  // Bottom of the canyon on the sub band, top on air, with per-cell scatter so a
  // row is a section of the stack rather than a line of identical cones.
  band = clamp(((cell.y + 0.5) * P - FLOOR_Y) / 3.6, 0.0, 1.0);
  band = clamp(band + (hash12(cell) - 0.5) * 0.16, 0.0, 1.0);
  level = clamp(spectrumNow(band), 0.0, 1.0);

  float R = P * 0.46 * mix(1.0, 0.62, band);   // woofers big, tweeters small
  r = length(q) / R;

  float z = gThrow * (0.30 * (level - 0.42)
                    + 0.34 * uBeatPulse * sin(uTime * 34.0 + hash12(cell) * TAU)
                    + 0.20 * uOnset);

  return driverProfile(r, z) * R;
}

float map(vec3 p) {
  vec2 cell;
  float r, band, level;
  float bulge = wallBulge(p, cell, r, band, level);

  float wall = (WALL - abs(p.x)) - bulge;
  return min(wall * 0.5, p.y - FLOOR_Y);
}

/// Studio behind the canyon: a cold sky above, warmth spilling off the floor.
vec3 env(vec3 d) {
  vec3 c = mix(palClamp(0.04) * 0.5, palClamp(0.30) * 0.8, d.y * 0.5 + 0.5);
  c += palClamp(0.95) * pow(max(0.0, d.y), 6.0) * 0.35;
  return c;
}

void main() {
  gPitch = clamp(p_pitch, 0.25, 1.6);
  gThrow = p_throw;

  vec2 uv = centered(vUv, uAspect);
  float F = 1.35 + 0.14 * uBeatPulse;

  // Flying forward, swaying, rolling a little on every bar. The sway is what
  // makes the walls pass at different rates and sells the width of the canyon.
  float fly = uTime * p_flow;
  vec3 ro = vec3(sin(uTime * 0.31) * 0.55, -0.15 + sin(uTime * 0.23) * 0.30, fly);
  vec3 ta = ro + vec3(sin(uTime * 0.19) * 0.6, sin(uTime * 0.17) * 0.18, 2.0);
  mat3 cam = lookAt(ro, ta, sin(uTime * 0.11) * 0.11 + uBarPulse * 0.05);
  vec3 rd = normalize(cam * vec3(uv, F));

  vec3 key = normalize(vec3(0.0, 0.85, -0.5));

  // March, gathering haze on the way in. The cones are emitters and the canyon
  // is full of air; without the haze the light stops dead at every surface and
  // the whole thing reads as a photograph of speakers rather than as a room.
  float t = 0.15;
  vec3 haze = vec3(0.0);
  bool hit = false;

  for (int i = 0; i < 128; i++) {
    vec3 p = ro + rd * t;

    // One evaluation per step, reused for the distance and for the haze —
    // calling map() as well would double the cost of the whole march.
    vec2 cell;
    float r, band, level;
    float bulge = wallBulge(p, cell, r, band, level);
    float toWall = (WALL - abs(p.x)) - bulge;
    float d = min(toWall * 0.5, p.y - FLOOR_Y);

    float ds = max(0.006, d * 0.5);
    haze += palClamp(0.20 + 0.65 * band) * level * level * exp(-max(0.0, toWall) * 1.4) * ds * 0.30;

    if (d < 0.0012 * t) { hit = true; break; }
    if (t > 34.0) break;
    t += ds;
  }

  vec3 col;

  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, 0.0025);

    vec2 cell;
    float r, band, level;
    float bulge = wallBulge(p, cell, r, band, level);

    // Which surface won in map(), rather than a guess from the height: at the
    // far end of the canyon the hit epsilon is centimetres and a cone sitting
    // near the floor would be shaded as floor.
    if (p.y - FLOOR_Y < ((WALL - abs(p.x)) - bulge) * 0.5) {
      // Floor: wet-looking, ruled, and carrying the light off both walls.
      vec3 refl = env(reflect(rd, n));
      float grid = min(abs(fract(p.x * 0.8 + 0.5) - 0.5), abs(fract(p.z * 0.8 + 0.5) - 0.5));
      col = palClamp(0.03) * 0.6;
      col += palClamp(0.60) * smoothstep(clamp(0.008 * t, 0.008, 0.4), 0.0, grid) * 0.16;
      col += refl * 0.30;
      col += palClamp(0.45) * exp(-(WALL - abs(p.x)) * 1.1) * 0.35 * uRms;
    } else {
      // Materials by radius: paper cone, rubber surround, cast basket.
      // Fibre, running round the cone. The offset within the cell has to be
      // rebuilt here; the +1e-4 keeps atan defined at the exact centre, where
      // both of its arguments would otherwise be zero.
      vec2 s = vec2(p.z + step(0.0, p.x) * gPitch * 0.5, p.y);
      vec2 q = s - (cell + 0.5) * gPitch;

      vec3 paper = mix(vec3(0.30, 0.28, 0.28), palClamp(0.34), 0.55 * p_tint);
      paper *= 0.88 + 0.20 * valueNoise(vec2(r * 30.0, atan(q.y, q.x + 1e-4) * 9.0));
      vec3 rubber = vec3(0.075, 0.075, 0.085);
      vec3 basket = mix(vec3(0.20, 0.20, 0.22), palClamp(0.12), 0.4);
      vec3 capCol = mix(vec3(0.22, 0.21, 0.22), palClamp(0.62), 0.7 * p_tint);

      vec3 mat = paper;
      mat = mix(mat, capCol, 1.0 - smoothstep(0.21, 0.26, r));
      mat = mix(mat, rubber, smoothstep(0.68, 0.76, r) * (1.0 - smoothstep(0.88, 0.94, r)));
      mat = mix(mat, basket, smoothstep(0.92, 0.98, r));

      float diff = max(0.0, dot(n, key));
      float ao = ambientOcclusion(p, n);
      float fres = pow(1.0 - max(0.0, dot(n, -rd)), 4.0);

      // Rubber and the cap are glossy, paper is not, and the roll takes a wide
      // band of light all the way round the cone — which is the whole read of
      // the shape at this distance.
      float gloss = mix(0.12, 1.0, smoothstep(0.70, 0.78, r) * (1.0 - smoothstep(0.88, 0.94, r)))
                  + (1.0 - smoothstep(0.19, 0.25, r)) * 0.9;
      float spec = pow(max(0.0, dot(n, normalize(key - rd))), 24.0) * gloss;

      col = mat * (0.10 + 0.85 * diff) * (0.30 + 0.70 * ao);
      col += vec3(1.0, 0.97, 0.92) * spec * 0.8;
      col += env(reflect(rd, n)) * fres * 0.5;

      // Lit from behind as it is driven, so a loud band lights its own rows.
      col += palClamp(0.20 + 0.65 * band) * level * level * 0.55
             * (1.0 - smoothstep(0.50, 0.92, r));
    }

    col = mix(col, palClamp(0.03) * 0.5, smoothstep(6.0, 30.0, t));
  } else {
    col = env(rd);
  }

  col += haze * p_glow * 2.4;

  // Air between the walls, so the far end of the canyon has depth rather than
  // just darkness.
  col += palClamp(0.35) * exp(-length(uv * vec2(0.7, 1.1)) * 1.6) * 0.10 * (0.5 + uRms);

  col *= 0.92 + 0.18 * uBeatPulse;
  col *= 1.0 - 0.34 * pow(clamp(length(uv * vec2(0.5, 0.8)), 0.0, 1.0), 2.3);
  fragColor = vec4(max(col, 0.0), 1.0);
}
