#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// A sand sea, flown low.
//
// The height is three scales stacked and each one is doing a different job. The
// sine crest gives dunes that march in ranks the way a real erg does, and the
// fBm inside its phase is what stops those ranks being a corrugated roof. The
// ridged term supplies the sharp crease along the top - ordinary fBm rounds it
// off and the field immediately reads as hills, not dunes. The ripples are
// cosmetic but they are what gives the surface a sense of scale.
//
// Marched as a heightfield with a cone step rather than a fixed one: sand is
// mostly empty air above it, and stepping proportional to the clearance covers
// the distance in a fraction of the samples.

float duneHeight(vec2 p, float t, int octaves) {
  float crest = sin(p.x * 0.35 + fbm(p * 0.10, 3, 2.0, 0.5) * 6.0) * 0.5 + 0.5;
  float h = crest * 1.1 + ridged(p * 0.16, octaves) * 1.5;
  h *= p_relief;
  h += 0.05 * p_ripples * sin(p.x * 7.0 + fbm(p * 0.6, 2, 2.0, 0.5) * 8.0 + t * 1.4);
  return h;
}

// Cheap version for the march itself. Detail the ray never resolves is detail
// paid for at every step of every pixel.
float marchHeight(vec2 p, float t) { return duneHeight(p, t, 3); }

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  vec3 ro = vec3(0.0, 3.1, t * 3.2);
  vec3 rd = normalize(vec3(uv, 1.7));
  rd.yz = rot(-0.08) * rd.yz;
  rd.xz = rot(sin(t * 0.05) * 0.15) * rd.xz;   // slow drift of the heading

  vec3 L = normalize(vec3(-0.62, 0.12 + 0.5 * clamp(p_sun, 0.0, 1.0), 0.42));

  // --- march ---------------------------------------------------------------
  int steps = int(clamp(p_steps, 30.0, 160.0));
  float d = 0.6;
  float prev = d;
  float hit = -1.0;
  for (int i = 0; i < 160; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * d;
    float clearance = p.y - marchHeight(p.xz, t);
    if (clearance < 0.02) { hit = d; break; }
    prev = d;
    // 0.45 rather than 1.0 because the field is not a true distance function;
    // a full step overshoots the slip faces and punches holes through crests.
    d += max(0.10, clearance * 0.45);
    if (d > 110.0) break;
  }

  // Bisect between the last clear sample and the hit. At grazing angles the
  // march lands a long way inside the surface and the raw hit distance stairsteps
  // visibly along the far crests; four halvings cost nothing and remove it.
  if (hit > 0.0) {
    float lo = prev, hi = hit;
    for (int i = 0; i < 4; i++) {
      float mid = (lo + hi) * 0.5;
      vec3 sp = ro + rd * mid;
      if (sp.y - marchHeight(sp.xz, t) < 0.0) hi = mid; else lo = mid;
    }
    hit = hi;
  }

  // --- sky ------------------------------------------------------------------
  float toSun = sat(dot(rd, L));
  vec3 sky = mix(palClamp(0.80), palClamp(0.28), sat(rd.y * 1.8 + 0.06));
  sky += palClamp(0.99) * pow(toSun, 300.0) * 2.0;            // disc
  sky += palClamp(0.88) * pow(toSun, 6.0) * 0.4;              // glare
  sky = mix(sky, palClamp(0.72), pow(sat(1.0 - rd.y * 2.4), 6.0) * 0.5);  // horizon dust

  if (hit < 0.0) {
    fragColor = vec4(sky * (0.94 + 0.2 * uBeatPulse), 1.0);
    return;
  }

  // --- surface --------------------------------------------------------------
  vec3 p = ro + rd * hit;

  // Sample the normal at a width that grows with distance, so far dunes are not
  // shaded off ripples smaller than their own pixels.
  float e = 0.03 + hit * 0.004;
  float h0 = duneHeight(p.xz, t, 5);
  float hx = duneHeight(p.xz + vec2(e, 0.0), t, 5);
  float hz = duneHeight(p.xz + vec2(0.0, e), t, 5);
  vec3 n = normalize(vec3((h0 - hx) / e, 1.0, (h0 - hz) / e));

  float diff = sat(dot(n, L));

  // Shadow march along the sun ray. Long shadows off the crests are most of
  // what makes a dune field read as a dune field rather than a bumpy plane.
  float shadow = 1.0;
  float sd = 0.25;
  for (int i = 0; i < 24; i++) {
    vec3 sp = p + L * sd;
    float diffH = sp.y - marchHeight(sp.xz, t);
    shadow = min(shadow, sat(diffH * 6.0 / sd));
    if (shadow < 0.02) break;
    sd += 0.28 + sd * 0.14;
    if (sd > 26.0) break;
  }
  shadow = mix(1.0, shadow, 0.9);

  // Sand: a bright body colour, forward-scattering hard toward a low sun.
  float sheen = pow(sat(dot(reflect(-L, n), -rd)), 14.0);
  float sky_ao = sat(0.35 + 0.65 * n.y);

  vec3 sand = palClamp(0.34 + 0.40 * diff * shadow + 0.12 * sky_ao);
  sand += palClamp(0.96) * sheen * shadow * 0.45;
  // Bounce from the sky into the shadowed faces, so they go blue-cool rather
  // than simply black.
  sand += palClamp(0.22) * (1.0 - shadow) * sky_ao * 0.5;

  // Glitter on the windward slopes.
  float sparkle = pow(sat(valueNoise(p.xz * 90.0) - 0.72) * 3.6, 3.0);
  sand += palClamp(0.99) * sparkle * diff * shadow * 0.5;

  float fog = 1.0 - exp(-hit * p_haze * 0.022);
  vec3 col = mix(sand, sky, fog);

  col *= 0.94 + 0.2 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
