#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Shells that overlap.
//
// Each slot runs its own clock, offset by an irrational-ish stride, so at any
// instant some shells are climbing, some are at full spread and some are down to
// smoke. That staggering is what makes the frame look busy without ever needing
// more than a handful of them.
//
// A shell is drawn twice. The sparks are angular lanes - the pixel's bearing is
// quantised, each lane gets its own jittered radius - which is cheap and gives
// the discrete stars a real firework has. The smoke is an fBm billow on the same
// centre that outlives the sparks and cools as it fades. Either one alone reads
// as a flat ring; together they read as a burst.

const float CYCLE = 2.7;   // seconds between re-fires of a single slot

vec3 shell(vec2 uv, float fi, float t, float aspect) {
  float ph = t / CYCLE + fi * 0.3701;
  float epoch = floor(ph);
  float age = fract(ph);

  float seed = hash11(epoch * 17.31 + fi * 5.77);
  float seed2 = hash11(seed * 31.7 + 3.1);

  vec2 c = (hash22(vec2(seed, fi)) - 0.5) * vec2(1.75 * aspect, 1.15);
  c.y += 0.22;

  vec3 tint = pal(fract(seed * 0.7 + 0.3));
  vec3 hot = mix(tint, vec3(1.0), 0.5);
  vec3 col = vec3(0.0);

  // --- ascent -------------------------------------------------------------
  // A comet rising to the burst point, easing out as it runs out of thrust.
  const float RISE = 0.22;
  if (age < RISE) {
    float k = age / RISE;
    float ease = k * k * (3.0 - 2.0 * k);
    vec2 h = mix(vec2(c.x * 0.4, -1.2), c, ease);
    vec2 q = uv - h;
    q.y *= 0.30;                       // stretch the falloff into a vertical streak
    float dh = length(q);
    col += hot * (0.0025 / (dh + 0.0025)) * (1.0 - k * 0.7) * 0.9;
  }

  // --- open shell ---------------------------------------------------------
  float bt = sat((age - RISE * 0.9) / (1.0 - RISE * 0.9));
  if (bt <= 0.0) return col;

  // pow 0.35 rather than sqrt: the shell has to be open before the eye can
  // resolve it, and any slower the burst spends its brightest frames as a
  // dense ball with the individual stars packed invisibly inside it.
  float R = p_size * (0.25 + 0.75 * pow(bt, 0.35)) * (0.65 + 0.5 * seed2);

  vec2 d = uv - c;
  d.y += bt * bt * p_gravity * 0.5;     // the shell sags as it slows

  float r = length(d);
  float th = atan(d.y, d.x);

  // Angular lanes. floor(lane) + 0.5 is the lane's centre line; the fractional
  // part of the bearing measured against it gives the distance across the lane.
  float lanes = floor(22.0 + 30.0 * seed2);
  float lf = th / TAU * lanes;
  float li = floor(lf) + 0.5;
  float jit = hash11(li * 2.17 + seed * 77.0);

  // Two tiers of star, chosen per lane: a full-radius outer shell and a shorter
  // inner one. It costs nothing over a single tier and it is the difference
  // between a dandelion and a burst with depth in it.
  float tier = step(0.42, hash11(li * 5.31 + seed * 11.0));
  float rr = R * mix(0.46, 1.0, tier) * (0.76 + 0.42 * jit);

  float arc = (lf - li) / lanes * TAU * r;   // arc length off the lane centre
  float w = 0.008 + 0.016 * R;
  float ray = exp(-(arc * arc) / (w * w));

  // Radial profile: a hard head at the lane's radius with a soft tail trailing
  // back toward the centre - the streak the star has already flown through.
  float head = exp(-(max(0.0, r - rr) * max(0.0, r - rr)) / (w * w * 2.0));
  float tail = step(r, rr) * exp(-(rr - r) / (R * 0.30 + 1e-4));

  float spark = ray * (head + 0.55 * tail);
  // Per-star twinkle, on its own phase so the shell shimmers rather than pulses.
  spark *= 0.6 + 0.4 * sin(hash11(li + seed * 13.0) * 60.0 + t * 34.0);

  float fade = (1.0 - bt) * (1.0 - bt);
  col += hot * spark * fade * p_bright;

  // The flash at detonation. Kept small and short: any longer and every shell
  // spends most of its life as a white ball with the stars lost inside it.
  col += hot * exp(-bt * 16.0) * exp(-(r * r) / (0.002 + 0.03 * bt)) * 1.4;

  // --- smoke --------------------------------------------------------------
  // The billow outlives the sparks and cools as it goes, so a burst leaves
  // something behind instead of simply switching off. It is also what makes the
  // overlaps read: two shells crossing share their smoke.
  float sr = max(R * 1.15, 1e-3);
  float n = fbm(d * (2.4 / sr) + vec2(seed * 21.0, -t * 0.35), 4, 2.2, 0.55);
  float body = smoothstep(1.0, 0.1, r / sr);
  float smoke = sat(body * (n * 1.6 + 0.3) - 0.22);
  float slife = smoothstep(0.0, 0.10, bt) * pow(1.0 - bt, 0.7);
  col += mix(hot, palClamp(0.45), bt) * smoke * slife * p_smoke * 2.2;

  // Wide halo, so the burst lights the air around it rather than ending at the
  // outermost star.
  col += tint * exp(-r / (R * 0.85 + 1e-3)) * fade * p_smoke * 0.4;

  return col;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * clamp(p_rate, 0.2, 3.0);

  // Night sky, brighter toward the horizon.
  vec3 col = mix(palClamp(0.16), palClamp(0.01), sat(uv.y * 0.45 + 0.5));

  // Stars: one candidate per cell, kept only where the cell's hash clears a
  // threshold, so they scatter instead of sitting on a grid.
  vec2 g = uv * 22.0;
  vec2 gi = floor(g);
  float sk = hash12(gi);
  vec2 gp = fract(g) - 0.5 - (hash22(gi) - 0.5) * 0.7;
  col += vec3(0.75, 0.8, 1.0) * smoothstep(0.9, 1.0, sk)
       * exp(-dot(gp, gp) * 70.0) * (0.35 + 0.65 * hash11(sk * 37.0));

  int count = int(clamp(p_shells, 1.0, 10.0));
  for (int i = 0; i < 10; i++) {
    if (i >= count) break;
    col += shell(uv, float(i), t, uAspect);
  }

  // Everything the bursts add spills a little into the sky.
  col += palClamp(0.5) * sat(luma(col) - 0.35) * 0.35;

  fragColor = vec4(col, 1.0);
}
