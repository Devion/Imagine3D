#include "common.glsl"
#include "palette.glsl"

// Rings of cubes spiralling down a funnel.
//
// The whole structure is built in polar space: x becomes the bearing and y the
// radius, so one modulo on x repeats a cube all the way round a ring, and
// multiplying x by the radius before that modulo makes the outer rings hold
// proportionally more cubes without anything counting them. Rounding y to a
// lattice is what separates the rings; offsetting z by sqrt(radius) is what
// curves them away into a funnel.
//
// The march accumulates min(d, exp(-d/0.08)) along the ray rather than stopping
// at the surface, so the rings behind the front one still show through and the
// funnel reads as deep.
//
// Technique reference: the polar cube-array Shadertoys.

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float gT;

float map(vec3 u) {
  float t = gT;
  float l = clamp(p_rings, 2.0, 8.0);
  const float w = 40.0;             // depth the funnel curves over
  float s = clamp(p_size, 0.1, 0.8);
  float f = 1e20;

  u.yz = -u.zy;
  u.xy = vec2(atan(u.x, u.y), length(u.xy));   // polar
  u.x += t / 6.0;                              // counter-rotate the whole array

  for (float i = 1.0; i <= 8.0; i += 1.0) {
    if (i > l) break;
    vec3 p = u;

    // Snap to a ring, skipping l-1 rows so each family owns its own set.
    float y = round(max(p.y - i, 0.0) / l) * l + i;

    p.x *= y;                          // more cubes the further out the ring is
    p.x -= sqrt(y * t * t * 2.0);      // rings further out lead the spiral
    p.x -= round(p.x / TAU) * TAU;     // repeat around the ring
    p.y -= y;
    p.z += sqrt(y / w) * w;            // curve the inner rings away

    float z = cos(y * t * p_wave / 50.0) * 0.5 + 0.5;   // the travelling wave
    p.z += z * 2.0;

    f = min(f, sdRoundBox(p, vec3(s * z), 0.1));
  }
  return f;
}

void main() {
  vec2 uv = centered(vUv, uAspect) * 0.5;
  gT = uTime * p_speed * 5.0;

  vec3 ro = vec3(0.0, 20.0, -120.0);
  vec3 rd = normalize(vec3(uv, 1.0));

  // Fixed pitch; the reference took this from the mouse and this is its default.
  mat2 pitch = rot(-0.17 * PI);

  int steps = int(clamp(p_steps, 24.0, 90.0));
  vec3 col = vec3(0.0);
  float d = 0.0;

  for (int i = 0; i < 90; i++) {
    if (i >= steps) break;
    vec3 p = rd * d + ro;
    p.yz = pitch * p.yz;

    float s = map(p);

    // Ring index drives the ramp, so colour travels outward with the wave
    // instead of being pinned to screen position.
    float r = (cos(round(length(p.xz)) * gT / 50.0) * 0.7 - 1.8) * 0.5;

    col += min(s, exp(-s / 0.08)) * pal(fract(r * 0.35 + 0.55)) * (r + 2.4);

    if (s < 1e-3 || d > 1e3) break;
    d += s * 0.7;
  }

  col = pow(col, vec3(1.0 / 2.2));
  col *= 0.9 + 0.35 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
