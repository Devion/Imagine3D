#include "common.glsl"
#include "palette.glsl"

// An Apollonian packing (iq's) unioned with a sine-fold lattice, marched with a
// glow accumulator and one reflection pass.
//
// The source is golfed to the point of relying on uninitialised locals reading as
// zero - `float s, i, d;` then `for(o *= i; ...)`. That is undefined behaviour,
// not a promise, so everything here is explicitly zeroed. Same maths, defined
// behaviour.
//
// The light is accumulated *inside* the distance function rather than shaded
// afterwards: every map() call along the ray adds an inverse-square term, so the
// glow is a by-product of how much marching happened near the source. That is why
// it bleeds through the structure instead of being occluded by it.

// Light gathered by map() this pixel. Reset explicitly before each march - it is
// a running total, not a value.
vec3 light = vec3(0.0);

// Sine-folded lattice: fold into the unit cell, then invert about the origin and
// rescale, tracking the accumulated scale so the result stays a distance.
float sineFold(vec3 p) {
  float w = 0.5, l = 0.0;
  for (int i = 0; i < 8; i++) {
    p = abs(sin(p)) - 1.0;
    l = 1.4 / dot(p, p);
    p *= l;
    w *= l;
  }
  return length(p) / w - 0.00235;
}

// Apollonian, after iq. Repeated sphere inversion is what packs the spheres.
float apollonian(vec3 p, float t) {
  float scale = 1.0, r;
  p.xy -= 3.0;

  for (int i = 0; i < 6; i++) {
    p = mod(p - 1.0, 2.0) - 1.0;

    // Deliberately a fraction of the orbit rate, not the whole of it.
    //
    // This angle is applied once per iteration to space that the previous
    // iteration has already inverted and rescaled, so it is nothing like a rigid
    // spin: the deeper packings sweep several times faster than the outer ones.
    // Driving it at the full `t` (~1 rad/s) churned the structure roughly five
    // times faster than anything comparable in the library - fractalpyramid, the
    // other effect that rotates inside its iteration, runs 0.2-0.4 - and the
    // result read as strobing rather than as motion.
    p.xz *= rot(t * p_churn);

    r = dot(p, p) * 0.9;
    p /= r;
    scale /= r;
  }

  // Inverted y-planes read as spheres; the xz length reads as the cylindrical
  // edges between them.
  return 0.45 * min(abs(p.y), length(p.xz)) / scale - 0.0015;
}

float map(vec3 p, float t) {
  p.z -= 10.0;
  // The camera orbit. A rigid rotation of the whole field, so it can afford to
  // run several times faster than the fold above without reading as frantic.
  p.xz *= rot(t / 3.0);

  float ball = length(p) - 0.5;

  float d = min(sineFold(p / 4.0) * 4.0, apollonian(p / 4.0, t) * 4.0);

  light += mix(vec3(9.0, 1.5, 1.0), pal(0.12) * 9.0, p_tint) / (0.1 + ball * ball);

  // The 3-|y| slab is a floor and ceiling, so the fractal has something to sit in.
  return min(3.0 - abs(p.y), d);
}

float ambientOcclusion(vec3 pos, vec3 nor, float t) {
  float sca = 2.0, occ = 0.0;
  for (int i = 0; i < 5; i++) {
    float hr = 0.01 + float(i) * 0.5 / 4.0;
    occ += (hr - map(nor * hr + pos, t)) * sca;
    sca *= 0.7;
  }
  return clamp(1.0 - occ, 0.0, 1.0);
}

void main() {
  float t = uTime * p_speed;

  vec2 u = (vUv - 0.5) * 2.0 * vec2(uAspect, 1.0);
  vec3 dir = normalize(vec3(u, 2.0));

  light = vec3(0.0);

  vec4 o = vec4(0.0);
  vec3 p = vec3(0.0);
  float s = 0.0, d = 0.0;

  int steps = int(clamp(p_steps, 30.0, 140.0));
  for (int i = 0; i < 140; i++) {
    if (i >= steps) break;
    p += dir * s;
    s = map(p, t);
    d += s;
    o += s;
  }

  o.rgb += light * p_glow / 10.0;

  // Tetrahedron normal.
  const float h = 0.005;
  const vec2 k = vec2(1.0, -1.0);
  vec3 n = normalize(k.xyy * map(p + k.xyy * h, t) +
                     k.yyx * map(p + k.yyx * h, t) +
                     k.yxy * map(p + k.yxy * h, t) +
                     k.xxx * map(p + k.xxx * h, t));

  // Reflection march. The light total is reset first so the reflected image
  // carries its own glow rather than inheriting the primary ray's.
  vec3 ref = vec3(0.0);
  light = vec3(0.0);
  p += n * 0.05;
  dir = reflect(dir, n);
  s = 0.0;
  for (int i = 0; i < 42; i++) {
    p += dir * s;
    s = map(p, t);
    ref += s;
  }

  o *= ambientOcclusion(p, n, t);
  o.rgb += o.rgb * ref * p_reflect + light * p_glow / 10.0;

  // Tone map with distance falloff, so the far field resolves instead of clipping.
  vec3 col = tanh(o.rgb / 16.0 * exp(-d / 6.0));

  fragColor = vec4(max(col, 0.0), 1.0);
}
