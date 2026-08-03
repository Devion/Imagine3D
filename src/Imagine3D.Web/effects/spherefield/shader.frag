#include "common.glsl"
#include "palette.glsl"
#include "sdf.glsl"

// An infinite repeated sphere lattice. opRepeat makes one primitive into endless
// geometry, so the whole scene costs a single distance evaluation.

float map(vec3 p) {
  vec3 q = opRepeat(p, vec3(p_spacing));
  float spheres = sdSphere(q, p_radius);

  // A thin connecting lattice, so it reads as a structure not loose balls.
  vec3 r = abs(q);
  float bars = min(min(length(r.xy), length(r.yz)), length(r.xz)) - p_radius * 0.16;

  return min(spheres, bars);
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  vec3 ro = vec3(sin(t * 0.3) * 0.8, cos(t * 0.23) * 0.6, t);
  vec3 target = ro + vec3(sin(t * 0.17) * 0.3, sin(t * 0.11) * 0.2, 1.0);
  mat3 cam = lookAt(ro, target, sin(t * 0.09) * 0.15);
  vec3 rd = normalize(cam * vec3(uv, 1.5));

  int steps;
  float dist = raymarch(ro, rd, 30.0, int(clamp(p_steps, 24.0, 160.0)), steps);

  vec3 col;
  if (dist < 30.0) {
    vec3 p = ro + rd * dist;
    vec3 n = calcNormal(p, 0.002);

    vec3 lightDir = normalize(vec3(0.6, 0.8, -0.4));
    float diff = max(0.0, dot(n, lightDir));
    float shadow = softShadow(p + n * 0.02, lightDir, 0.02, 6.0, 12.0);
    float ao = ambientOcclusion(p, n);
    float fres = pow(1.0 - max(0.0, dot(n, -rd)), 3.0);

    // Colour from world position so neighbouring cells differ.
    vec3 base = palClamp(fract(dot(floor(p / p_spacing), vec3(0.13, 0.21, 0.37))) * 0.8 + 0.1);

    col = base * (0.18 * ao + 0.85 * diff * shadow);
    col += palClamp(0.9) * fres * 0.6;
    col += base * 0.25 * ao;

    // Distance fog into the palette's dark end.
    col = mix(col, palClamp(0.05), smoothstep(8.0, 26.0, dist));
  } else {
    col = mix(palClamp(0.02), palClamp(0.3), sat(uv.y * 0.4 + 0.5)) * 0.6;
  }

  // Step count as a subtle glow: grazing rays brighten edges for free.
  col += palClamp(0.75) * float(steps) / p_steps * 0.12;
  col *= 0.9 + 0.3 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
