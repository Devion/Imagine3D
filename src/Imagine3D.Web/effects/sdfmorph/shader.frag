#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "sdf.glsl"

// A mass of liquid metal that morphs through the platonic primitives while
// satellites orbit into it and are absorbed.
//
// The old version fused four drifting primitives with smin() and left it there.
// smin is a good operator and a poor subject: the shapes never became anything,
// the group sat in the middle of an empty frame, and nothing in it answered the
// music beyond a brightness pulse. Three things changed.
//
// The core actually morphs now, which is what the effect is named for. It mixes
// the *distance functions* of a sphere, a cube, an octahedron and a torus rather
// than cross-fading two renders: the mix of two bounds is still a bound, so the
// marcher keeps working while the shape is genuinely halfway between a cube and
// an octahedron - a solid that has no name and cannot be modelled any other way.
// Only the two primitives either side of the current position are evaluated.
//
// The whole group lives in twisted space, applied before anything is measured,
// so the satellites bend along the same curve as the core instead of orbiting a
// shape that is warping independently of them.
//
// And it is chrome, which means the environment is doing most of the work. A
// mirror shows what is around it; put it in a smooth gradient and it reads as
// grey plastic. There are strip lights around the horizon here for the surface
// to sweep across, and one reflection bounce so the mass carries its own
// satellites in itself.

float gBlend, gSpread, gSpeed, gWarp, gRipple, gMorph;

const vec3 KEY = vec3(0.3651, 0.8347, -0.4126);   // normalize(0.35, 0.80, -0.395)

/// The core, morphing through four primitives over one turn of `m`.
float coreShape(vec3 p, float m) {
  const float r = 0.80;
  float f = fract(m) * 4.0;
  int i = int(f);
  float k = smoothstep(0.0, 1.0, fract(f));

  if (i == 0) return mix(sdSphere(p, r), sdBox(p, vec3(r * 0.70)), k);
  if (i == 1) return mix(sdBox(p, vec3(r * 0.70)), sdOctahedron(p, r * 1.18), k);
  if (i == 2) return mix(sdOctahedron(p, r * 1.18), sdTorus(p, vec2(r * 0.66, r * 0.30)), k);
  return mix(sdTorus(p, vec2(r * 0.66, r * 0.30)), sdSphere(p, r), k);
}

float map(vec3 p) {
  float t = uTime * gSpeed;

  // Twist, applied to the space rather than to any one shape.
  p.xz *= rot(p.y * gWarp * (0.45 + 0.35 * sin(t * 0.31)) + t * 0.13);

  float d = coreShape(p, gMorph);

  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float a = t * (0.55 + 0.17 * fi) + fi * (TAU / 5.0);

    // Each satellite on its own tilted orbit, breathing in and out - so some are
    // clear of the mass, some are being swallowed, and which is which changes.
    vec3 c = vec3(cos(a), sin(a * 0.73 + fi), sin(a));
    c.yz = rot(fi * 0.7) * c.yz;
    c *= gSpread * (1.0 + 0.22 * sin(t * 0.6 + fi * 2.1));

    vec3 q = p - c;
    q.xz = rot(t * (0.8 + 0.2 * fi)) * q.xz;
    q.xy = rot(fi - t * 0.6) * q.xy;

    float rr = 0.20 + 0.11 * hash11(fi + 1.0);
    float s;
    if (i == 0)      s = sdBox(q, vec3(rr));
    else if (i == 1) s = sdTorus(q, vec2(rr * 1.4, rr * 0.45));
    else if (i == 2) s = sdOctahedron(q, rr * 1.6);
    else if (i == 3) s = sdBox(q, vec3(rr * 1.3, rr * 0.4, rr * 0.4));
    else             s = sdSphere(q, rr);

    d = smin(d, s, gBlend);
  }

  // Shockwave: a ripple leaving the centre on every hit. This is what makes the
  // *surface* answer the music rather than only its colour.
  d -= gRipple * sin(length(p) * 13.0 - t * 5.0) * 0.022;

  return d;
}

/// Around the mass: a graded sky, a ring of strip lights at the horizon and one
/// hard key. The strips are the point - a mirror needs edges to sweep across.
vec3 env(vec3 d) {
  vec3 c = mix(palClamp(0.02) * 0.8, palClamp(0.28) * 1.2, d.y * 0.5 + 0.5);

  float around = atan(d.z, d.x) / TAU;
  float band = pow(max(0.0, 1.0 - abs(d.y) * 2.2), 6.0);
  c += pal(fract(around * 3.0 + uTime * 0.02)) * band
       * (0.55 + 0.45 * sin(around * TAU * 6.0 + uTime * 0.5)) * 1.3;

  c += vec3(1.0, 0.96, 0.90) * pow(max(0.0, dot(d, KEY)), 26.0) * 3.0;
  c += palClamp(0.55) * pow(max(0.0, -d.y), 4.0) * 0.35;
  return c;
}

void main() {
  gBlend = max(0.01, p_blend);
  gSpread = p_spread;
  gSpeed = p_speed;
  gWarp = clamp(p_warp, 0.0, 0.9);
  gRipple = p_ripple;
  gMorph = p_morph;

  vec2 uv = centered(vUv, uAspect);

  // Orbit, plus a dolly that pushes in over each phrase and a slow roll. The old
  // camera held one distance for the whole video and left the mass sitting in a
  // frame three times its size.
  float orbit = uTime * 0.15;
  float dist = 2.75 - 0.35 * sin(uPhrase * TAU) - 0.15 * uBeatPulse;
  vec3 ro = vec3(sin(orbit) * dist, 0.55 + sin(uTime * 0.21) * 0.45, cos(orbit) * dist);
  mat3 cam = lookAt(ro, vec3(0.0, 0.05 * sin(uTime * 0.17), 0.0), sin(uTime * 0.08) * 0.12);
  vec3 rd = normalize(cam * vec3(uv, 1.55 + 0.12 * uBeatPulse));

  // March. Written out rather than using raymarch() so the aura around the mass
  // can be gathered on the way in - and at a shorter step, because twisted space
  // and a rippled surface both overstate the distance this field reports.
  int steps = int(clamp(p_steps, 24.0, 190.0));
  float t = 0.0;
  bool hit = false;
  vec3 aura = vec3(0.0);

  for (int i = 0; i < 190; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * t;
    float d = map(p);
    float ds = max(0.004, d * 0.45);

    aura += palClamp(0.35 + 0.4 * sin(uTime * 0.3)) * exp(-max(0.0, d) * 5.5) * ds * 0.30;

    if (d < 0.0015 * t) { hit = true; break; }
    if (t > 14.0) break;
    t += ds;
  }

  vec3 col;

  if (hit) {
    vec3 pos = ro + rd * t;
    vec3 n = calcNormal(pos, 0.0018);

    float ao = ambientOcclusion(pos, n);
    float shadow = softShadow(pos + n * 0.03, KEY, 0.03, 5.0, 12.0);
    float diff = max(0.0, dot(n, KEY));
    float fres = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(n, -rd)), 5.0);

    vec3 refl = reflect(rd, n);

    // One bounce. Chrome that only ever shows the sky reads as a painted ball;
    // seeing the satellites curved across the core is what says it is a mirror.
    vec3 mirror = env(refl);
    float rt = 0.04;
    for (int i = 0; i < 48; i++) {
      float dd = map(pos + n * 0.03 + refl * rt);
      if (dd < 0.004 || rt > 6.0) break;
      rt += max(0.006, dd * 0.45);
    }
    if (rt <= 6.0) {
      vec3 rp = pos + n * 0.03 + refl * rt;
      vec3 rn = calcNormal(rp, 0.005);
      mirror = palClamp(0.18 + 0.55 * (rn.y * 0.5 + 0.5))
               * (0.15 + 0.85 * max(0.0, dot(rn, KEY)))
               + env(reflect(refl, rn)) * 0.35;
    }

    vec3 base = palClamp(0.20 + 0.55 * (n.y * 0.5 + 0.5));

    col = base * (0.10 * ao + 0.28 * diff * shadow);
    col += mirror * mix(0.30, 1.0, fres) * (0.25 + 0.75 * ao);
    col += vec3(1.0) * pow(max(0.0, dot(n, normalize(KEY - rd))), 60.0) * shadow * 1.3;
    col += palClamp(0.95) * fres * 0.30;
  } else {
    col = env(rd) * 0.55;
    // Something for the far field to be, so the frame is not half empty gradient.
    col += palClamp(0.60) * pow(fbm(uv * 1.3 + vec2(uTime * 0.02, 0.0), 5, 2.0, 0.5), 3.0) * 0.55;
  }

  col += aura * p_glow;

  col *= 0.90 + 0.30 * uBeatPulse;
  col *= 1.0 - 0.30 * pow(clamp(length(uv * vec2(0.5, 0.8)), 0.0, 1.0), 2.4);
  fragColor = vec4(max(col, 0.0), 1.0);
}
