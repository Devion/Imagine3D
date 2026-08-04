#include "common.glsl"
#include "palette.glsl"

// Two gyroids, offset from each other by half a period, marched with one
// reflection bounce.
//
// The gyroid is `dot(cos(p), sin(p.zxy))` - three cosines against three sines,
// which costs almost nothing and produces an infinite triply-periodic surface
// with no seams and no tiling artefacts. The second copy shifted by PI in z
// interleaves with the first, so the camera flies through a lattice of two
// materials that never touch.
//
// The camera was mouse-orbited in the source; here it is on a slow automatic
// look-around, which is what `sway` scales.

#define FAR 30.0

// Which of the two surfaces the last map() call landed on. A global because the
// march needs the material without paying for a second evaluation.
int matId = 0;

mat3 lookAt(vec3 dir) {
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 rt = normalize(cross(dir, up));
  return mat3(rt, cross(rt, dir), dir);
}

float gyroidField(vec3 p) { return dot(cos(p), sin(p.zxy)) + 1.0; }

float map(vec3 p) {
  float r = 1e5, d;

  d = gyroidField(p);
  if (d < r) { r = d; matId = 1; }

  d = gyroidField(p - vec3(0.0, 0.0, PI));
  if (d < r) { r = d; matId = 2; }

  return r;
}

float march(vec3 ro, vec3 rd) {
  float t = 0.0;
  for (int i = 0; i < 150; i++) {
    float d = map(ro + rd * t);
    if (abs(d) < 0.001) break;
    t += d;
    if (t > FAR) break;
  }
  return t;
}

float ambientOcclusion(vec3 p, vec3 n) {
  float occ = 0.0;
  for (float i = 0.0; i < 4.0; i++) {
    float t = i * 0.08;
    occ += t - map(p + n * t);
  }
  return clamp(1.0 - occ, 0.0, 1.0);
}

vec3 surfaceNormal(vec3 p) {
  vec2 e = vec2(0.5773, -0.5773) * 0.001;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx)
                 + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

vec3 trace(vec3 ro, vec3 rd) {
  vec3 acc = vec3(0.0);
  vec3 throughput = vec3(1.0);

  for (int bounce = 0; bounce < 2; bounce++) {
    float d = march(ro, rd);
    if (d > FAR) break;

    float fog = 1.0 - exp(-p_fog * d * d);
    throughput *= 1.0 - fog;

    vec3 p = ro + rd * d;

    // The cosine term roughens the normal at a much finer scale than the
    // surface, which is what gives the gyroid its brushed, faceted sheen.
    vec3 n = normalize(surfaceNormal(p) + pow(abs(cos(p * 64.0)), vec3(16.0)) * 0.1);

    vec3 lp = vec3(10.0, -10.0, -10.0 + ro.z);
    vec3 ld = normalize(lp - p);

    float diff = max(0.0, 0.5 + 2.0 * dot(n, ld));
    float wrap = pow(length(sin(n * 2.0) * 0.5 + 0.5), 2.0);
    float sky = max(0.0, 0.5 + 0.5 * dot(n, vec3(0.0, 0.0, 1.0)));
    float spec = max(0.0, dot(reflect(-ld, n), -rd));
    float fres = 1.0 - max(0.0, dot(-rd, n));

    vec3 col = vec3(0.0);
    col += pal(0.62) * diff;
    col += pal(0.02) * wrap;
    col += pal(0.85) * sky;
    col += vec3(0.3, 0.25, 0.25) * pow(spec, 4.0) * 8.0;

    // Freckling: a high-frequency cosine thresholded per material, so the two
    // surfaces are told apart by texture as well as by hue.
    float freck = dot(cos(p * 23.0), vec3(1.0));
    vec3 alb = vec3(0.0);
    if (matId == 1) {
      alb = mix(vec3(0.2, 0.1, 0.9), pal(0.7), p_tint);
      alb *= max(0.6, step(2.5, freck));
    }
    if (matId == 2) {
      alb = mix(vec3(0.6, 0.3, 0.1), pal(0.2), p_tint);
      alb *= max(0.8, step(-2.5, freck));
    }

    col *= alb;
    col *= ambientOcclusion(p, n);
    acc += throughput * col;

    rd = reflect(rd, n);
    ro = p + n * 0.01;
    throughput *= p_reflect * fres;
  }

  return acc;
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);

  vec3 ro = vec3(PI / 2.0, 0.0, -uTime * p_speed);
  vec3 rd = normalize(vec3(uv, -0.5));

  // The source's no-mouse fallback, which is the better camera anyway: a roll
  // that tracks a target circling ahead of the ray.
  rd.xy = rot(sin(uTime * 0.2) * p_sway) * rd.xy;
  vec3 target = vec3(cos(uTime * 0.4), sin(uTime * 0.4), 4.0);
  rd = lookAt(normalize(target)) * rd;

  vec3 col = trace(ro, rd);

  col *= smoothstep(0.0, 1.0, 1.2 - length(uv * 0.9));
  col *= 0.92 + 0.2 * uBeatPulse;
  col = pow(max(col, 0.0), vec3(0.4545));

  fragColor = vec4(col, 1.0);
}
