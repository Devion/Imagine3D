#include "common.glsl"
#include "palette.glsl"

// A low-poly terrain flyover under a banded sun.
//
// The ground is a *triangulated* value noise. The plane is sheared into a
// triangular lattice, the three corners of the cell are hashed, and the height is
// interpolated barycentrically across whichever of the two triangles the point
// falls in. That is where the faceted look comes from - ordinary bilinear value
// noise comes out smooth, and the whole read depends on the facets being flat.
//
// The noise returns a second component: the distance to the nearest triangle
// edge. The barycentric weights needed for it have already been computed for the
// height, so the neon wireframe costs nothing beyond a min() of three terms.
//
// Technique reference: the "synthwave sunset" family of Shadertoys.

float gBass;   // bass, folded into the height so the whole field breathes

float h21(vec2 co) {
  return fract(sin(dot(co.xy, vec2(1.9898, 7.233))) * 45758.5433);
}

// Flatten the field toward the middle so there is a corridor to fly down rather
// than a wall closing in on both sides.
float amp(vec2 p) { return smoothstep(1.0, 8.0, abs(p.x)); }

// a^512 by squaring. Used to sharpen a sine into a travelling ridge line: at that
// exponent everything but the very peak is crushed to zero.
float pow512(float a) {
  a *= a; a *= a; a *= a; a *= a; a *= a; a *= a; a *= a; a *= a;
  return a * a;
}

float corner(vec2 uv, float t) {
  float a = amp(uv);
  if (a <= 0.0) return -gBass;
  float w = 1.0 - 0.4 * pow512(0.51 + 0.49 * sin((0.02 * (uv.y + 0.5 * uv.x) - t) * 2.0));
  float h = h21(uv);
  return a * (h * sqrt(h)) * w - gBass;
}

vec2 trinoise(vec2 uv, float t) {
  const float sq = 1.22474487139;   // sqrt(3/2)
  uv.x *= sq;
  uv.y -= 0.5 * uv.x;

  vec2 d = fract(uv);
  uv -= d;

  // Which half of the cell: the lattice is two triangles per parallelogram.
  bool c = dot(d, vec2(1.0)) > 1.0;
  vec2 dd = 1.0 - d;
  vec2 da = c ? dd : d;
  vec2 db = c ? d : dd;

  float n1 = corner(uv + float(c), t);
  float n2 = corner(uv + vec2(1.0, 0.0), t);
  float n3 = corner(uv + vec2(0.0, 1.0), t);

  float nmid = mix(n2, n3, d.y);
  float ns = mix(n1, c ? n2 : n3, da.y);
  float dx = da.x / max(db.y, 1e-5);

  float edge = min(min((1.0 - dx) * db.y, da.x), da.y);
  return vec2(mix(ns, nmid, dx), edge);
}

vec2 mapTerrain(vec3 p, float t) {
  vec2 n = trinoise(p.xz, t);
  return vec2(p.y - 2.0 * n.x * p_relief, n.y);
}

vec3 grad(vec3 p, float t) {
  const vec2 e = vec2(0.005, 0.0);
  float a = mapTerrain(p, t).x;
  return vec3(mapTerrain(p + e.xyy, t).x - a,
              mapTerrain(p + e.yxy, t).x - a,
              mapTerrain(p + e.yyx, t).x - a) / e.x;
}

// Star field on a folded lattice: each pass shrinks and rotates the space, so
// four cheap passes give several densities of star without four hashes per star.
float starnoise(vec3 rd) {
  float c = 0.0;
  vec3 p = normalize(rd) * 300.0;
  for (int i = 0; i < 4; i++) {
    vec3 q = fract(p) - 0.5;
    vec3 id = floor(p);
    float s = smoothstep(0.5, 0.0, length(q));
    s *= step(h21(id.xz / max(abs(id.y), 1e-3)), 0.06 - float(i) * float(i) * 0.005);
    c += s;
    p = p * 0.6 + 0.5 * p * mat3(0.6, 0.0, 0.8, 0.0, 1.0, 0.0, -0.8, 0.0, 0.6);
  }
  c *= c;
  float g = dot(sin(rd * 10.512), cos(rd.yzx * 10.512));
  c *= smoothstep(-PI, -0.9, g) * 0.5 + 0.5 * smoothstep(-0.3, 1.0, g);
  return c * c;
}

vec3 sky(vec3 rd, vec3 ld, bool stars) {
  float haze = exp2(-5.0 * (abs(rd.y) - 0.2 * dot(rd, ld)));
  vec3 col = mix(palClamp(0.24), palClamp(0.62), sat(haze));

  if (stars) col += vec3(1.0) * starnoise(rd) * (1.0 - min(haze, 1.0)) * 0.8;

  // The sun, cut into horizontal bands. exp(-yd*14) spaces them so they crowd
  // toward the horizon the way the reference look does.
  float sun = smoothstep(0.21, 0.2, distance(rd, ld));
  if (sun > 0.0 && stars) {
    float yd = rd.y - ld.y;
    sun *= smoothstep(-0.8, 0.0, sin(3.1 * exp(-yd * 14.0)));
    col = mix(col, palClamp(0.93), sun);
  }
  return col;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;
  gBass = uBass * p_pulse * 0.12;

  vec3 ro = vec3(0.0, 1.0, t * 10.0);
  vec3 rd = normalize(vec3(uv, 1.333));

  vec3 ld = normalize(vec3(0.0, 0.125 + 0.05 * sin(0.1 * t), 1.0));

  int steps = int(clamp(p_steps, 24.0, 140.0));
  float d = 0.0;
  float edge = 0.0;
  bool hit = false;
  for (int i = 0; i < 140; i++) {
    if (i >= steps) break;
    vec3 p = ro + d * rd;
    vec2 s = mapTerrain(p, t);
    // Half steps: the height field is not a distance function and a full step
    // walks straight through the facets at grazing angles.
    d += s.x * 0.5;
    if (abs(s.x) < 0.003 * d) { hit = true; edge = s.y; break; }
    if (d > 150.0 || p.y > 2.5) break;
  }

  vec3 col;
  if (!hit) {
    col = sky(rd, ld, true);
  } else {
    vec3 p = ro + d * rd;
    vec3 n = normalize(grad(p, t));
    float diff = dot(n, ld) + 0.1 * n.y;

    col = palClamp(0.14) * diff;

    // The ground is wet-looking because it is mostly reflection: at grazing
    // angles the Fresnel term hands almost the whole surface over to the sky.
    vec3 rf = sky(reflect(rd, n), ld, true);
    col = mix(col, rf, 0.05 + 0.95 * pow(max(1.0 + dot(rd, n), 0.0), 5.0));

    // Neon wireframe along every triangle edge.
    col = mix(col, palClamp(0.88) * p_wire, smoothstep(0.05, 0.0, edge));

    vec3 fog = exp2(-d * vec3(0.14, 0.10, 0.28));
    col = mix(sky(rd, ld, false), col, fog);
  }

  col *= 0.94 + 0.25 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
