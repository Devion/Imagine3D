#include "common.glsl"
#include "palette.glsl"
#include "panel.glsl"

// Interference between ring sources, in space rather than on a plane.
//
// The flat version put two centres on the screen and multiplied their sine
// fields. That is the honest moire and it is nearly free, but both sources sat
// at the same distance forever, so the pattern could only ever slide - it never
// approached, never passed, and the frame had no more depth at the end of a
// scene than at the start.
//
// The sources are points in 3D here, projected each frame. Distance is measured
// to the point in space rather than to its shadow on the screen, which is what
// makes a source that is coming toward the camera open its rings out as it
// arrives - the thing a flat pair cannot do. It costs one extra multiply per
// source, and it is the whole difference between wallpaper and a room.

const float FOCAL = 1.4;

/// Ring phase at screen point p for a source at world position s (z forward).
///
/// Measured as the closest approach of the ray through p to the source, which is
/// a true distance in the scene rather than a distance on the screen. That one
/// change is where the depth comes from: closest approach grows with how far
/// down the ray the source sits, so a source at the back of the scene packs its
/// rings tight and the same source arriving at the lens opens them out until one
/// ring fills the frame.
float ringPhase(vec2 p, vec3 s, float freq) {
  vec3 dir = normalize(vec3(p, FOCAL));
  float along = dot(s, dir);
  float across = sqrt(max(0.0, dot(s, s) - along * along));
  return across * freq;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  // Three sources on their own orbits, at their own depths. Two beat; the third
  // is what stops the beat from being periodic.
  float sep = p_separation;
  float sweep = p_depth;

  vec3 s1 = vec3(cos(t) * sep, sin(t * 1.3) * sep, 2.0 + sweep * sin(t * 0.61));
  vec3 s2 = vec3(cos(-t * 0.8 + 2.0) * sep, sin(-t * 1.1) * sep, 2.0 + sweep * sin(t * 0.43 + 2.1));
  vec3 s3 = vec3(cos(t * 0.47 + 4.0) * sep * 1.4, sin(t * 0.63 + 1.0) * sep * 1.4,
                 2.6 + sweep * sin(t * 0.29 + 4.2));

  // Each source is tuned to a different part of the spectrum. Ring spacing is
  // what the interference pattern is made of, so driving the three separately
  // means the music moves the *pattern* — the beat frequency between them
  // changes — rather than just brightening a fixed one.
  float freq = p_frequency;
  float r1 = ringPhase(uv, s1, freq * (0.72 + 0.55 * spectrumNow(0.12)));
  float r2 = ringPhase(uv, s2, freq * (0.72 + 0.55 * spectrumNow(0.50)));
  float r3 = ringPhase(uv, s3, freq * 0.62 * (0.72 + 0.55 * spectrumNow(0.88)));

  float a = sin(r1);
  float b = sin(r2);
  float c = sin(r3 + t * 1.7);

  // Product of the ring fields: where they align you get the moire beat. The
  // third is mixed rather than multiplied in, so it modulates the beat instead
  // of dividing it in half again.
  float v = a * b * mix(1.0, c * 0.5 + 0.5, p_third);

  vec3 col;
  if (p_hard > 0.5) {
    // Two-tone rings, which is what a 1-bitplane display would have produced.
    float bit = step(0.0, v);
    col = mix(palClamp(0.10), palClamp(0.85), bit);
    // Slow colour wash so it is not literally monochrome, taken from the depth
    // of the nearest source rather than from the clock: the frame changes hue
    // when something moves, not on a timer.
    col *= 0.7 + 0.5 * (0.5 + 0.5 * sin(r1 * 0.13 - t * 2.0));
  } else {
    col = palClamp(v * 0.5 + 0.5);
  }

  // A source close to the camera lights the frame around itself. This is what
  // gives the pattern a near and a far, and it is the only term here that is not
  // scale-free - which is exactly why it reads as depth.
  for (int i = 0; i < 3; i++) {
    vec3 s = i == 0 ? s1 : (i == 1 ? s2 : s3);
    vec2 sp = s.xy * (FOCAL / max(0.35, s.z));
    float near = smoothstep(2.0 + sweep, 0.8, s.z);
    col += palClamp(0.55 + 0.35 * float(i) * 0.5)
           * exp(-length(uv - sp) * (2.2 + 3.0 * s.z)) * near * 0.55 * p_bloom;
  }

  col *= 0.88 + 0.3 * uBeatPulse;

  fragColor = vec4(max(col, 0.0), 1.0);
}
