#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Aurora curtains.
//
// Accumulated as a thin volume rather than a surface: each step samples a 2D
// noise field that says where a curtain is, and multiplies by a vertical profile
// that is dark at the base and fades out at the top. Sheets are made thin by
// raising the noise to a high power, which is what gives the folded, ribboned
// look instead of a fog bank.

float curtain(vec2 p, float t) {
  // Two scales of horizontal folding, drifting at different rates.
  float fold = fbm(vec2(p.x * 1.4 + t * 0.35, p.y * 0.6 - t * 0.15), 4, 2.1, 0.55);
  float fine = fbm(vec2(p.x * 5.0 - t * 0.5, p.y * 1.8 + t * 0.25), 3, 2.0, 0.5);

  float sheet = fold * 0.75 + fine * 0.25;

  // Thin it into ribbons. A 6th power looked right on paper but leaves almost
  // nothing to accumulate - fBm sits near 0.5, so 0.5^6 is 0.015 and forty steps
  // of that is invisible. Cubed keeps the folded ribbon shape while leaving
  // enough signal to actually light the sky.
  return pow(smoothstep(0.35, 0.85, sheet), 3.0);
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  vec3 ro = vec3(0.0, 0.0, 0.0);
  vec3 rd = normalize(vec3(uv, 1.3));

  vec3 col = vec3(0.0);

  // --- stars behind everything ---
  vec2 sg = uv * 90.0;
  float star = step(0.9965, hash12(floor(sg)));
  float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + hash12(floor(sg)) * 40.0);
  col += vec3(0.8, 0.85, 1.0) * star * twinkle * 0.7;

  // Horizon glow.
  col += palClamp(0.18) * exp(-abs(uv.y + 0.55) * 4.0) * 0.5;

  // --- curtains ---
  int steps = int(clamp(p_steps, 12.0, 90.0));
  float acc = 0.0;

  for (int i = 0; i < 90; i++) {
    if (i >= steps) break;

    // March up through the sky; only rays heading upward hit the sheet volume.
    float fi = float(i) / float(steps);
    float height = 0.05 + fi * 2.4 * p_spread;

    if (rd.y <= 0.002) break;
    float dist = height / rd.y;
    if (dist > 45.0) break;

    vec3 pos = ro + rd * dist;

    float c = curtain(pos.xz * 0.25, t) * p_curtains;

    // Vertical profile: aurora is dim at the base, brightest a third of the way
    // up, and fades to nothing at the top.
    float profile = smoothstep(0.0, 0.35, fi) * smoothstep(1.0, 0.4, fi);

    float density = c * profile;
    acc += density;

    // Colour shifts with altitude - green low, violet high - and the palette
    // keeps it in the run's world.
    col += palClamp(0.35 + fi * 0.55) * density * 1.35;
  }

  // Bloom around the brightest folds.
  col += palClamp(0.8) * smoothstep(0.25, 1.8, acc) * 0.5;

  col *= 0.92 + 0.28 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
