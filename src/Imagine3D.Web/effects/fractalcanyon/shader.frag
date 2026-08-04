#include "common.glsl"
#include "palette.glsl"

// A flight down a fractal canyon.
//
// There is no light in this shader and no ambient occlusion. The surface colour
// is (1 - |normal|) and nothing else; every bit of form you read comes from the
// edge term. Comparing the distance estimate at a point against the average of
// its two neighbours on each axis measures how sharply the field bends there,
// which is large exactly along creases and silhouettes and near zero on flats.
// Subtracting that gives an inked outline for the price of the normal you were
// already computing.
//
// Technique reference: Kali's "Fractal Cartoon" / "DE edge detection" Shadertoy.

float gDet;    // hit tolerance, grown with distance so far detail is not chased
float gEdge;   // edge strength, written by normal()

// "Amazing Surface": a fold, a shear, an inversion. Four rounds turn a plane
// into a canyon with overhangs.
vec4 formula(vec4 p) {
  p.xz = abs(p.xz + 1.0) - abs(p.xz - 1.0) - p.xz;
  p.y -= 0.25;
  p.xy = rot(radians(35.0)) * p.xy;
  return p * 2.0 / clamp(dot(p.xyz, p.xyz), 0.2, 1.0);
}

float de(vec3 pos, float t) {
  pos.y += sin(pos.z - t * 6.0) * p_waves;

  vec3 tp = pos;
  tp.z = abs(3.0 - mod(tp.z, 6.0));   // repeat the canyon along z
  vec4 p = vec4(tp, 1.0);
  for (int i = 0; i < 4; i++) p = formula(p);
  float walls = (length(max(vec2(0.0), p.yz - 1.5)) - 1.0) / p.w;

  // The road: a slab, with a groove subtracted from it, and dashes subtracted
  // from the groove. Each max(a, -b) is a cut.
  float road = max(abs(pos.x + 1.0) - 0.3, pos.y - 0.35);
  road = max(road, -max(abs(pos.x + 1.0) - 0.1, pos.y - 0.5));
  pos.z = abs(0.25 - mod(pos.z, 0.5));
  road = max(road, -max(abs(pos.z) - 0.2, pos.y - 0.3));
  road = max(road, -max(abs(pos.z) - 0.01, -pos.y + 0.32));

  return min(walls, road);
}

vec3 path(float ti) {
  ti *= 1.5;
  return vec3(sin(ti), (1.0 - sin(ti * 2.0)) * 0.5, -ti * 5.0) * 0.5;
}

vec3 normal(vec3 p, float t) {
  vec3 e = vec3(0.0, gDet * 5.0, 0.0);

  float d1 = de(p - e.yxx, t), d2 = de(p + e.yxx, t);
  float d3 = de(p - e.xyx, t), d4 = de(p + e.xyx, t);
  float d5 = de(p - e.xxy, t), d6 = de(p + e.xxy, t);
  float d = de(p, t);

  gEdge = abs(d - 0.5 * (d2 + d1)) + abs(d - 0.5 * (d4 + d3)) + abs(d - 0.5 * (d6 + d5));
  gEdge = min(1.0, pow(gEdge, 0.55) * 15.0);

  return normalize(vec3(d1 - d2, d3 - d4, d5 - d6));
}

void main() {
  vec2 uv = centered(vUv, uAspect) * 0.5;
  float t = uTime * p_speed * 0.5;

  vec3 dir = normalize(vec3(uv * p_fov * 2.0, 1.0));

  // Aim the camera down the path by looking at where it will be shortly.
  vec3 go = path(t);
  vec3 adv = path(t + 0.7);
  vec3 advec = normalize(adv - go);
  float an = adv.x - go.x;
  an *= min(1.0, abs(adv.z - go.z)) * sign(adv.z - go.z) * 0.7;
  dir.xy = rot(-an) * dir.xy;
  an = advec.y * 1.7;
  dir.yz = rot(-an) * dir.yz;
  an = atan(advec.x, advec.z);
  dir.xz = rot(-an) * dir.xz;

  vec3 from = vec3(-1.0, 0.7, 0.0) + go;

  // --- march ---------------------------------------------------------------
  gEdge = 0.0;
  gDet = 0.001;
  float d = 100.0, total = 0.0;
  vec3 p = from;
  int steps = int(clamp(p_steps, 40.0, 170.0));
  for (int i = 0; i < 170; i++) {
    if (i >= steps || d <= gDet || total >= 25.0) break;
    p = from + total * dir;
    d = de(p, t);
    // Tolerance grows exponentially with distance: chasing 0.001 at range 20
    // spends the whole step budget resolving detail smaller than a pixel.
    gDet = 0.001 * exp(0.13 * total);
    total += d;
  }

  p -= (gDet - d) * dir;
  vec3 nor = normal(p, t);

  vec3 col = (1.0 - abs(nor)) * max(0.0, 1.0 - gEdge * 0.8 * p_ink);

  // --- sky ------------------------------------------------------------------
  total = clamp(total, 0.0, 26.0);
  vec3 sdir = dir;
  sdir.y -= 0.02;

  // A ray-star sun: the angular term chops the disc into spokes and spins them.
  float sunsize = 7.0 - uRms * 3.0;
  float ang = atan(sdir.x, sdir.y) + uTime * 1.5;
  float spoke = abs(0.2 - mod(ang, 0.4));
  float s  = pow(sat(1.0 - length(sdir.xy) * sunsize - spoke), 0.1);
  float sb = pow(sat(1.0 - length(sdir.xy) * (sunsize - 0.2) - spoke), 0.1);
  float sg = pow(sat(1.0 - length(sdir.xy) * (sunsize - 4.5) - 0.5 * spoke), 3.0);

  float y = mix(0.45, 1.2, pow(smoothstep(0.0, 1.0, 0.75 - sdir.y), 2.0)) * (1.0 - sb * 0.5);

  vec3 bg = palClamp(0.35) * ((1.0 - s) * (1.0 - sg) * y + (1.0 - sb) * sg * 3.0 * 0.5);
  bg += palClamp(0.92) * s;
  bg = max(bg, sg * palClamp(0.8));

  col = mix(palClamp(0.85), col, exp(-0.004 * total * total));
  if (total > 25.0) col = bg;

  col = pow(col, vec3(1.4)) * 1.2;
  col = mix(vec3(length(col)), col, 0.65);

  // Pull the frame into the run's palette. Mixing rather than multiplying is
  // deliberate: the normal colouring is the whole look, and multiplying by a
  // palette stop just dims it toward that stop's hue. Mixing keeps the
  // normal-derived structure while moving it into the video's colour world.
  col = mix(col, palClamp(0.15 + 0.75 * sat(luma(col))), clamp(p_tint, 0.0, 1.0));

  // Vignette, on the un-aspect-corrected uv so it hugs the frame.
  vec2 o = (vUv - 0.5) * 2.0;
  col *= pow(max(0.0, 1.05 - length(o * o * vec2(0.62, 0.66))), 0.35);

  fragColor = vec4(col * (0.94 + 0.25 * uBeatPulse), 1.0);
}
