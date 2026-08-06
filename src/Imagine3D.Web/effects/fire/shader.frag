#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Rising fire, in layers of depth.
//
// The original ran one flame front along the bottom of the frame: the classic
// cellular decay buffer, done here as fBm advected upward so it needs no
// feedback buffer and stays resolution independent. That part is unchanged and
// is still what makes the tongues.
//
// What it was not was a scene. One front means the fire lives in the bottom
// third and the other two thirds are black, which reads as a title-screen effect
// - fine over an intro, useless as a shot to hold. So the same front is now
// drawn several times over: a far ridge burning on the horizon, a middle one,
// and a wall of it right up against the lens. Each layer is smaller, slower and
// hazier than the one in front, which is what perspective does to fire, and
// between them they light the whole frame. Above them is smoke, lit from
// underneath by the fire that is making it, so even the top of the frame is
// carrying the scene.
//
// Nothing here is marched. Layers composite front to back, and a layer that has
// already been covered by an opaque one in front is skipped.

/// One flame front. `base` is where its fuel line sits, `scale` how big its
/// tongues are, and it returns premultiplied colour with coverage in .a.
vec4 front(vec2 uv, float base, float scale, float speed, float seed, float height) {
  // Advect upward and pinch toward the middle so flames lean inward.
  vec2 p = vec2(uv.x * 2.2, uv.y - base) / scale;
  p.y -= uTime * speed;
  p.x += sin((uv.y - base) * 3.0 / scale + uTime * 0.7 + seed) * 0.12;

  int oct = int(clamp(p_detail, 1.0, 8.0));
  float n = fbm(p * p_turbulence + seed * 31.0, oct, 2.1, 0.55);

  // Fuel falls off with height; the noise eats into it to make tongues.
  float fuel = 1.0 - (uv.y - base) / max(0.05, height * scale);
  if (fuel <= 0.0) return vec4(0.0);

  // The fuel line is not straight - it wanders, so a layer reads as a ridge of
  // fire at some distance rather than as a rectangle of it.
  float ridge = fbm(vec2(uv.x * 1.1 + seed * 7.0, uTime * 0.13), 3, 2.0, 0.5) - 0.5;
  fuel += ridge * 0.35;
  fuel *= smoothstep(-0.02, 0.10, uv.y - base + ridge * 0.12);

  float heat = clamp(fuel * 1.75 - n * 0.80, 0.0, 1.0);
  heat = pow(heat, 1.20);
  if (heat <= 0.002) return vec4(0.0);

  // Map heat through the palette's hot end, with a white core.
  vec3 col = palClamp(0.15 + heat * 0.85);
  col += vec3(1.0, 0.95, 0.85) * smoothstep(0.72, 1.0, heat) * 0.8;

  return vec4(col * heat, heat);
}

void main() {
  vec2 uv = vec2((vUv.x - 0.5) * uAspect + 0.5, vUv.y);

  // ---- sky and smoke ------------------------------------------------------
  // Smoke is the reason the top of the frame is not empty. It is lit from below
  // by whatever the fire underneath it is doing, which is also why it flickers
  // in time with the flames rather than drifting independently of them.
  float smokeN = fbm(vec2(uv.x * 1.4, uv.y * 1.9 - uTime * 0.16), 5, 2.1, 0.55);
  float smoke = smoothstep(0.30, 0.85, smokeN) * smoothstep(0.05, 0.45, uv.y);

  vec3 col = mix(palClamp(0.20), palClamp(0.01), sat(uv.y * 1.15)) * 0.5;
  col += palClamp(0.62) * smoke * (0.22 + 0.55 * exp(-max(0.0, uv.y - 0.25) * 2.2));
  // Underlit: the glow of the fire on the belly of the smoke. This is what
  // carries the top of the frame - the flames themselves only reach so far, and
  // without it everything above them is a black plate with embers in it.
  col += palClamp(0.85) * exp(-max(0.0, uv.y - 0.18) * 2.4) * (0.26 + 0.40 * uBass);

  // ---- the fronts, far to near -------------------------------------------
  // Three fronts at three depths. The far one is small, slow and washed into the
  // haze; the near one is large, fast and opaque. That progression is the whole
  // of the depth cue and it costs one extra fBm each.
  const int LAYERS = 3;
  for (int i = 0; i < LAYERS; i++) {
    float fi = float(LAYERS - 1 - i);      // 2 = furthest, 0 = nearest
    float depth = fi / float(LAYERS - 1);  // 0 near, 1 far

    // The near front's fuel line sits below the bottom edge, so what is on
    // screen is the middle of a wall of fire rather than the whole of a small
    // one. Only the far ridges get a horizon to stand on.
    float base = mix(-0.45, 0.30, depth) * p_stack;
    float scale = mix(1.35, 0.30, depth);
    float speed = p_speed * mix(1.0, 0.45, depth);

    vec4 f = front(uv, base, scale, speed, fi * 5.7, p_height);
    if (f.a <= 0.002) continue;

    // Distance haze: a ridge of fire a hundred metres off is orange light, not
    // orange flame, and washing it toward the palette is what says so.
    f.rgb = mix(f.rgb, palClamp(0.45) * f.a, depth * 0.55);
    f.rgb *= mix(1.15, 0.55, depth);

    col = col * (1.0 - f.a) + f.rgb;
  }

  // ---- embers -------------------------------------------------------------
  // Two parallax layers, so they read as particles at different distances rather
  // than as a texture stuck to the glass.
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float par = mix(1.0, 0.45, fi);
    vec2 eg = vec2(uv.x, vUv.y) * (44.0 / par) + vec2(fi * 13.0, -uTime * 2.4 * par);
    vec2 ecell = floor(eg);
    float ember = step(0.992, hash12(ecell + fi * 71.0)) *
                  smoothstep(0.6, 0.0, length(fract(eg) - 0.5));
    col += ember * palClamp(0.85) * (0.5 + uBeatPulse) * par;
  }

  col *= 0.90 + 0.26 * uBass + 0.18 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
