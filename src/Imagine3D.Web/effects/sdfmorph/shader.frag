#include "common.glsl"
#include "palette.glsl"
#include "sdf.glsl"

// Four primitives on independent orbits, fused with smin().
//
// smin is what separates this from a plain union: where two shapes approach,
// the surface bulges and joins instead of showing a hard intersection seam, so
// the field behaves like liquid metal.

float gBlend, gSpread, gSpeed;

float map(vec3 p) {
  float t = uTime * gSpeed;

  vec3 c1 = vec3(sin(t * 1.1), cos(t * 0.9), sin(t * 0.7)) * gSpread;
  vec3 c2 = vec3(cos(t * 0.8 + 2.0), sin(t * 1.3), cos(t * 0.6)) * gSpread;
  vec3 c3 = vec3(sin(t * 0.6 + 4.0), cos(t * 0.7 + 1.0), sin(t * 1.1 + 3.0)) * gSpread;
  vec3 c4 = vec3(cos(t * 1.2), sin(t * 0.5 + 2.5), cos(t * 0.9 + 1.5)) * gSpread;

  float d = sdSphere(p - c1, 0.42);

  vec3 q2 = p - c2;
  q2.xz = rot(t * 0.9) * q2.xz;
  q2.xy = rot(t * 0.6) * q2.xy;
  d = smin(d, sdBox(q2, vec3(0.3)), gBlend);

  vec3 q3 = p - c3;
  q3.yz = rot(t * 1.1) * q3.yz;
  d = smin(d, sdTorus(q3, vec2(0.36, 0.13)), gBlend);

  vec3 q4 = p - c4;
  q4.xy = rot(-t * 0.8) * q4.xy;
  d = smin(d, sdOctahedron(q4, 0.42), gBlend);

  // A slow central mass keeps the group from ever fully separating.
  d = smin(d, sdSphere(p, 0.3 + 0.08 * sin(t * 1.7)), gBlend * 1.3);

  return d;
}

void main() {
  gBlend = max(0.01, p_blend);
  gSpread = p_spread;
  gSpeed = p_speed;

  vec2 uv = centered(vUv, uAspect);

  float orbit = uTime * 0.15;
  vec3 ro = vec3(sin(orbit) * 2.4, 0.7 + sin(uTime * 0.21) * 0.4, cos(orbit) * 2.4);
  mat3 cam = lookAt(ro, vec3(0.0), 0.0);
  vec3 rd = normalize(cam * vec3(uv, 1.6));

  int steps;
  float t = raymarch(ro, rd, 14.0, int(clamp(p_steps, 24.0, 160.0)), steps);

  vec3 col;
  if (t < 14.0) {
    vec3 pos = ro + rd * t;
    vec3 n = calcNormal(pos, 0.0015);

    vec3 key = normalize(vec3(0.6, 0.8, -0.3));
    vec3 fill = normalize(vec3(-0.7, 0.1, 0.5));

    float diff = max(0.0, dot(n, key));
    float back = max(0.0, dot(n, fill));
    float ao = ambientOcclusion(pos, n);
    float shadow = softShadow(pos + n * 0.02, key, 0.02, 5.0, 14.0);
    float fres = pow(1.0 - max(0.0, dot(n, -rd)), 4.0);

    // Colour by surface normal so the melting is legible as form.
    vec3 base = palClamp(0.25 + 0.5 * (n.y * 0.5 + 0.5));

    col = base * (0.12 * ao + 0.85 * diff * shadow);
    col += palClamp(0.35) * back * 0.3;
    col += vec3(1.0) * pow(max(0.0, dot(n, normalize(key - rd))), 56.0) * 0.8;
    col += palClamp(0.95) * fres * 0.55;
  } else {
    col = mix(palClamp(0.2), palClamp(0.02), length(uv) * 0.6);
  }

  col *= 0.9 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
