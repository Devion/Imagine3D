#include "common.glsl"
#include "palette.glsl"

// Folded-space fractal, drawn by accumulating glow along the ray instead of
// stopping at the first hit.
//
// The distance estimator is the classic octahedral fold: rotate, mirror into the
// positive octant, translate, repeat. dot(sign(p), p) is a cheap octahedron
// bound, and folding it a few times turns one octahedron into a pyramid fractal.
//
// Marching *through* it and summing 1/d makes the interior visible - a normal
// surface render of this shape reads as a grey lump, because all the interest is
// in the layers behind the first hit.
//
// Technique reference: the "fractal pyramid" shader on Shadertoy.

float gFolds, gSpin;

float map(vec3 p) {
  int folds = int(clamp(gFolds, 2.0, 14.0));
  for (int i = 0; i < 14; i++) {
    if (i >= folds) break;
    float t = uTime * gSpin;
    p.xz = rot(t) * p.xz;
    p.xy = rot(t * 1.89) * p.xy;
    p.xz = abs(p.xz);
    p.xz -= 0.5;
  }
  return dot(sign(p), p) / 5.0;
}

void main() {
  gFolds = p_folds;
  gSpin = p_spin;

  vec2 uv = centered(vUv, uAspect) * 0.5;

  // Orbit the whole structure.
  vec3 ro = vec3(0.0, 0.0, -50.0);
  ro.xz = rot(uTime * p_orbit) * ro.xz;

  vec3 fwd = normalize(-ro);
  vec3 side = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = normalize(cross(fwd, side));
  vec3 rd = normalize(fwd * 3.0 + uv.x * side + uv.y * up);

  vec3 col = vec3(0.0);
  float t = 0.0;
  float d = 1.0;

  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    d = map(p) * 0.5;
    if (d < 0.02 || t > 120.0) break;

    // Glow falls off with the distance estimate, so grazing the surface lights
    // up and passing far from it contributes almost nothing.
    col += palClamp(fract(length(p) * 0.06 + uTime * 0.02)) / (400.0 * d);
    t += d;
  }

  col *= p_glow;

  // Tone-map: the accumulation is unbounded and would clip to white otherwise.
  col = col / (1.0 + col);
  col = pow(col, vec3(0.85));

  col *= 0.9 + 0.35 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
