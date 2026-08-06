#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Polar tunnel: 1/r is depth, angle is the wrap around the wall. The whole trick
// is that no geometry exists - it is a coordinate transform, and everything
// below is arithmetic on two numbers.
//
// It used to be that transform and a checkerboard, which is the 1993 version and
// reads as one: a flat pattern sliding toward the middle of the frame with
// nothing happening on it. The transform was never the problem - it is exact, it
// costs nothing, and it gives perfect perspective for free. What was missing was
// everything a corridor has apart from its walls.
//
// So: the cross-section breathes on the low end, light rings pass on the bar,
// strip lights run the length of it, sparks blow past, and the far end is a lit
// throat rather than a vignette. All of it is a function of (angle, z), so it is
// still one texture lookup's worth of work and still has no geometry in it.

void main() {
  vec2 uv = centered(vUv, uAspect);

  // Wobble the tunnel centre so the flight path curves.
  uv += vec2(sin(uTime * 0.7), cos(uTime * 0.53)) * p_wobble;

  float r0 = length(uv);
  float a = atan(uv.y, uv.x);

  // The cross-section is not a circle. Pushing the wall in and out with the low
  // end makes the corridor pump - the single strongest thing this effect can do
  // with a kick, and it costs one sine.
  float pump = 1.0 + p_pulse * (0.16 * uBass + 0.10 * uBeatPulse)
                    * sin(a * 3.0 - uTime * 1.7);
  float r = max(r0 * pump, 0.04);

  float depth = 1.0 / r;
  float z = depth + uTime * p_speed;

  // Twist increases with depth, so the far end of the tunnel corkscrews.
  float angle = a + z * p_twist;

  // --- the wall ------------------------------------------------------------
  vec2 tex = vec2(angle / TAU * p_rings, z);
  vec2 cell = floor(tex);
  vec2 within = fract(tex);
  float checker = mod(cell.x + cell.y, 2.0);

  // Bands of palette along the tunnel plus the checker as a brightness key.
  // Sampled a hair apart per channel: the wall runs to a vanishing point, and
  // that tiny dispersion is what stops the far end reading as flat colour.
  float f = fract(z * 0.06 + uTime * 0.02);
  float disp = p_disperse * 0.02;
  vec3 col = vec3(pal(f - disp).r, pal(f).g, pal(f + disp).b);
  col *= mix(0.45, 1.0, checker);

  // Panel bevel. The old version drew one hairline per cell edge; a lit edge on
  // two sides and a dark one on the other two is what makes a flat tile read as
  // a panel set into a wall.
  vec2 e = abs(within - 0.5);
  float edge = smoothstep(0.42, 0.5, max(e.x, e.y));
  col = mix(col, pal(fract(f + 0.5)), edge * 0.55);
  col *= 1.0 + 0.35 * smoothstep(0.30, 0.5, within.x) - 0.25 * smoothstep(0.30, 0.5, within.y);

  // Grain on the wall, so the panels are a surface rather than flat fill.
  col *= 0.88 + 0.24 * valueNoise(vec2(angle * 9.0, z * 3.0));

  // --- strip lights --------------------------------------------------------
  // A few lanes running the length of the corridor. These are what give the eye
  // a line to travel along, and they converge on the vanishing point for free.
  float lanes = max(2.0, floor(p_strips + 0.5));
  float lane = fract(angle / TAU * lanes + 0.5);
  float strip = exp(-abs(lane - 0.5) * 46.0);
  col += pal(fract(f + 0.35)) * strip * (0.55 + 0.85 * uMid) * p_glow;

  // --- rings passing -------------------------------------------------------
  // Light hoops set into the corridor at a fixed spacing. They come at the
  // camera because they are fixed in z, and they flare on the bar.
  float zr = abs(fract(z * 0.5) - 0.5);
  float ring = exp(-zr * 26.0);
  col += pal(fract(f + 0.7)) * ring * (0.45 + 1.1 * uBarPulse) * p_glow;

  // --- sparks --------------------------------------------------------------
  // Debris blowing down the tunnel. One hash per cell of a finer lattice, so
  // they scatter instead of marching in step.
  vec2 sg = vec2(angle / TAU * lanes * 3.0, z * 2.0);
  vec2 si = floor(sg);
  float spark = step(0.965, hash12(si))
              * exp(-length(fract(sg) - 0.5) * 7.0)
              * (0.5 + 0.5 * sin(hash12(si) * 90.0 + uTime * 20.0));
  col += mix(vec3(1.0), pal(fract(f + 0.15)), 0.5) * spark * 1.4 * p_sparks;

  // --- depth ---------------------------------------------------------------
  // Near wall hot, far wall falling into the throat. The old version multiplied
  // by a smoothstep on r, which darkens the middle of the frame and reads as a
  // vignette rather than as distance.
  float fog = smoothstep(0.0, 0.55 + 0.25 * uBeatPulse, r0);
  col *= mix(0.30, 1.25, fog);

  // The light at the end of it, flaring on the beat.
  vec3 throat = pal(fract(uTime * 0.05));
  // Kept under the walls. The throat is the brightest thing in the shot by
  // construction - everything converges on it - so at any gain that reads as
  // "bright" on its own it blows out and takes the panelling with it.
  col += throat * (1.0 - fog) * (0.28 + 0.55 * uEnergy + 0.45 * uBeatPulse) * p_glow;
  col += throat * exp(-r0 * 5.0) * 0.20 * p_glow;

  col = col / (1.0 + col * 0.30);
  fragColor = vec4(max(col, 0.0), 1.0);
}
