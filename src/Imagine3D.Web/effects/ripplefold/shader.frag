#include "common.glsl"
#include "palette.glsl"

// Two stages. First, a cellular pass scatters one expanding ring per grid cell -
// a raindrop - and accumulates their radial push into a displacement. Then that
// displaced coordinate is run through a fold loop that rotates, wraps and
// re-folds it, accumulating a value each pass. The rings are only ever a nudge to
// the input; all the visible structure comes out of the fold.
//
// The source generated its own two-lobed heartbeat with exp(-fract(t)) to pulse
// the zoom. uBeatPulse already is that shape and is locked to the track, so it
// drives the punch here instead of a free-running timer.

void main() {
  vec2 a = (vUv - 0.5) * vec2(uAspect, 1.0);

  // Zoom snap on the beat.
  a *= 1.0 - p_punch;

  float t = uTime * p_speed;

  // Slow breathing scale and roll.
  float breathe = 0.85 + 0.15 * sin(uTime * 0.6) + 0.05 * cos(uTime * 1.3);
  a = rot(0.08 * sin(uTime * 0.25)) * a * breathe;

  vec2 origin = a;
  vec2 push = vec2(0.0);

  // Raindrops, at two grid scales.
  for (int j = 0; j < 2; j++) {
    vec2 p = a * (5.0 + float(j) * 4.0);
    vec2 cell = floor(p);
    vec2 local = fract(p) - 0.5;

    for (int cy = -1; cy <= 1; cy++) {
      for (int cx = -1; cx <= 1; cx++) {
        vec2 off = vec2(float(cx), float(cy));
        vec2 id = cell + off;

        float seed = hash12(id);
        // Each drop runs its own 0..1 life at its own rate.
        float life = fract(uTime * (0.3 + seed * 0.2) + seed);

        vec2 jitter = off + vec2(fract(seed * 34.23) - 0.5, fract(seed * 89.45) - 0.5);
        vec2 r = local - jitter;

        float dist = length(r);
        // Fade the drop in at birth and out at death so rings do not pop.
        float alive = smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.8, life);

        // Distance behind the expanding wavefront. The sine makes the ripple,
        // the two exponentials confine it to a narrow band and fade it with age.
        float behind = max(0.0, dist - life * 1.5);
        float wave = sin(behind * 60.0) * exp(-behind * 15.0) * exp(-life * 3.0);

        push += r * wave * 0.12 * alive;
      }
    }
  }

  a += push * p_ripples;

  float k = dot(a, a);

  vec2 drift = vec2(0.0);
  vec3 acc = vec3(0.0);
  float scale = 1.0;
  float l = uTime * 0.5 * p_speed;

  int folds = int(clamp(p_folds, 8.0, 48.0));
  for (int i = 0; i < 48; i++) {
    if (i >= folds) break;
    float fi = float(i);

    a *= scale;
    scale *= 0.78;

    a = rot(sin(fi * 0.1 + l * 0.5)) * a;
    a += drift * 0.4;
    a += sin(a.yx * 10.8 + l + k * 5.2 - uBeatPulse * 0.15);

    float c = length(a);

    // A tight ring function divided by radius: bright near the fold centre,
    // falling off outward, which is what gives the filaments.
    float ring = dot(vec2(sin(c * 11.3), cos(c * 10.4)), vec2(0.5, 0.9)) / (0.01 + c);
    float shade = 0.5 + 0.5 * cos(fi * 0.2 + c * 1.5 - l * 1.2 + a.x * 0.5);

    acc += vec3(shade) * ring;

    drift += 0.2 * sin(c) * vec2(cos(a.x), sin(a.y * 3.2));
    a = 1.1 * fract(a * 0.35) - 1.0;
  }

  acc /= 45.0;
  acc = acc * 3.2 - 0.2;

  vec3 col = clamp(acc, 0.0, 1.0);

  // Centre weighting, then the ripple energy added back as a highlight so the
  // drops are visible as light and not only as distortion.
  col *= 1.8 / (1.0 + k * 12.0);
  col += vec3(1.0) * length(push) * 3.0 * (1.0 - min(k, 1.0));
  col = 1.0 - exp(-col * 2.5);

  // The source collapsed to luma here. Keeping that as the *structure* and
  // colouring it through the palette preserves the look without the greyscale.
  float v = luma(col);
  col = mix(vec3(v), palClamp(v) * (0.35 + v * 0.9), p_tint);

  col = pow(max(col, 0.0), vec3(0.4545));
  col *= 1.0 - 0.4 * dot(origin, origin);

  fragColor = vec4(col, 1.0);
}
