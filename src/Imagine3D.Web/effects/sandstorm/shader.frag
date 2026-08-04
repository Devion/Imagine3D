#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Wind-driven sand.
//
// The veil is four sheets of noise squashed hard across the wind and stretched
// along it, each at its own scale and speed. One sheet at any density looks like
// a moving texture; four sliding over each other at different rates is what
// reads as air with things suspended in it.
//
// A fifth, much slower layer gates the rest. Sand does not arrive evenly - it
// arrives in gusts, and the gaps between them are what make the gusts land.

void main() {
  vec2 uv = vUv;
  float t = uTime * p_speed;
  float amount = clamp(uAmount, 0.0, 1.0);

  float ang = p_angle * PI;
  vec2 w = vec2(cos(ang), sin(ang));
  vec2 perp = vec2(-w.y, w.x);

  // Work in an aspect-corrected frame so the streaks do not stretch with the
  // output resolution.
  vec2 a = uv * vec2(uAspect, 1.0);
  vec2 q = vec2(dot(a, w), dot(a, perp));

  float veil = 0.0, norm = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float sc = pow(1.9, fi);
    float sp = 1.0 + fi * 0.8;
    float amp = pow(0.62, fi);
    veil += fbm(vec2(q.x * sc * 0.55 - t * sp * 1.7, q.y * sc * 4.5), 3, 2.1, 0.55) * amp;
    norm += amp;
  }
  veil /= norm;

  float gust = fbm(vec2(q.x * 0.35 - t * 0.55, q.y * 0.5), 3, 2.0, 0.5);
  float dens = sat((veil - 0.42 + 0.36 * (gust - 0.5)) * 4.2) * p_density * amount;

  // Smear along the wind. Sand this thick is moving fast enough to take the
  // image with it, and the drag is what separates a storm from a fog overlay.
  vec2 stepv = w * p_smear * 0.012 * dens / vec2(uAspect, 1.0);
  vec3 src = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    float f = float(i) / 4.0;
    float wi = 1.0 - f * 0.72;
    src += texture(uPrev, uv - stepv * f).rgb * wi;
    wsum += wi;
  }
  src /= wsum;

  // The sand itself, brighter where it is thickest.
  vec3 sand = palClamp(0.58 + 0.28 * dens);
  vec3 col = mix(src, sand, sat(dens * 0.85));

  // Grains: a much finer, much faster layer, only visible inside the veil.
  float grains = pow(sat(fbm(vec2(q.x * 26.0 - t * 20.0, q.y * 120.0), 2, 2.0, 0.5) - 0.56) * 3.2, 2.0);
  col += palClamp(0.92) * grains * dens * p_grit * 0.7;

  // Airborne dust kills contrast before it kills brightness.
  float lum = luma(col);
  col = mix(col, vec3(lum) * palClamp(0.66) * 1.4, sat(dens * 0.45));

  fragColor = vec4(col, 1.0);
}
