#include "common.glsl"
#include "palette.glsl"

// A single coordinate pushed through dozens of sine displacements, each one
// reading the position the previous pass produced. Nothing is drawn - the image
// is entirely the final position of that coordinate, which is why it flows like
// a liquid rather than like a pattern being animated.
//
// The large constant boosts are deliberate: they drag the sample point a long way
// across the field every pass, so the result keeps sliding instead of settling.

// Cosine remapped to [minimum, minimum + range], the source's shaping helper.
float cosRange(float amt, float range, float minimum) {
  return (((1.0 + cos(radians(amt))) * 0.5) * range) + minimum;
}

void main() {
  vec2 uv = vUv;

  // Normalised by the *longer* axis, unlike most effects here - it keeps the
  // melt from blowing up to fill a tall frame.
  vec2 p = (2.0 * vUv - 1.0) * vec2(uAspect, 1.0) / max(uAspect, 1.0);

  float time = uTime * p_speed;

  float ct = cosRange(time * 5.0, 3.0, 1.1);
  float xBoost = cosRange(time * 0.2, 5.0, 5.0);
  float yBoost = cosRange(time * 0.1, 10.0, 5.0);
  float fScale = cosRange(time * 15.5, 1.25, 0.5) * p_swirl;

  int passes = int(clamp(p_passes, 4.0, 60.0));
  for (int i = 1; i <= 60; i++) {
    if (i >= passes) break;
    float fi = float(i);
    vec2 q = p;
    q.x += 0.25 / fi * sin(fi * p.y + time * cos(ct) * 0.5 / 20.0 + 0.005 * fi) * fScale + xBoost;
    q.y += 0.25 / fi * sin(fi * p.x + time * ct * 0.3 / 40.0 + 0.03 * (fi + 15.0)) * fScale + yBoost;
    p = q;
  }

  // The source read the final position as three fixed sine channels. Keeping the
  // three-phase structure preserves the banding; routing it through the palette
  // is what stops it importing its own rainbow.
  vec3 phases = vec3(
    0.5 * sin(3.0 * p.x) + 0.5,
    0.5 * sin(3.0 * p.y) + 0.5,
    sin(p.x + p.y) * 0.5 + 0.5);

  float band = dot(phases, vec3(0.4, 0.35, 0.25));

  // palClamp, not pal: the wrapping variant puts a seam where the ramp rolls from
  // the last stop back to the first, and because the melt drags large areas across
  // that seam at once it shows up as a hard-edged black blob rather than a subtle
  // discontinuity.
  vec3 col = palClamp(band);

  // Keep the original's channel separation so the bands stay distinct instead of
  // flattening into one sweep, with a floor so no region collapses to black.
  col *= 0.45 + 0.75 * phases;

  float vig = (1.0 - p_vignette * (uv.y - 0.5) * (uv.y - 0.5))
            * (1.0 - p_vignette * (uv.x - 0.5) * (uv.x - 0.5));
  col *= clamp(vig, 0.0, 1.0);

  col *= 0.9 + 0.3 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
