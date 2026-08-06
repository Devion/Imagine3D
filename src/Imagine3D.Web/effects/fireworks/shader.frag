#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Shells that overlap, flown through.
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
//
// Every shell also has a *depth*, and it closes on the camera as it burns.
// Measured over a third of a second, the flat version changed a lot and travelled
// nowhere: three per cent of the frame-to-frame difference was explained by any
// camera move at all, so it read as a busy postcard rather than as a place. A
// shell now launches deep in the scene and arrives at the lens as it dies, which
// means at any instant there is one filling the frame, a couple at mid distance
// and the rest small and far - and the whole field is expanding outward past the
// viewer. Depth is tied to the burst clock rather than to its own cycle, so a
// shell can never wrap from near to far where it would be seen doing it.

const float CYCLE = 2.7;   // seconds between re-fires of a single slot
const float FOCAL = 1.30;
// Not closer than this. A shell that gets near enough to enclose the lens puts
// the camera *inside* its spark ring, and the inside of a burst is a dark disc
// with a hard bright rim - which in a corner of the frame reads as a black wedge
// rather than as a firework. Just outside that is where the depth reads best.
const float ZNEAR = 0.95;  // where a shell has arrived
const float ZFAR  = 4.20;  // where it launches

vec3 shell(vec2 uv, float fi, float t, float aspect) {
  float ph = t / CYCLE + fi * 0.3701;
  float epoch = floor(ph);
  float age = fract(ph);

  float seed = hash11(epoch * 17.31 + fi * 5.77);
  float seed2 = hash11(seed * 31.7 + 3.1);

  // Depth, and the projection everything else is measured through. sat(age*1.15)
  // gets the shell to the lens a little before its light is gone, so it passes
  // rather than stopping in front of the camera.
  float z = mix(ZFAR, mix(ZFAR, ZNEAR, sat(age * 1.15)), clamp(p_flow, 0.0, 1.0))
          * (0.75 + 0.5 * hash11(seed * 7.7));
  float s = FOCAL / max(z, 0.2);

  // Wider spread in world units than the old screen-space one: at these depths
  // most of it projects back inside the frame, and the shells that do not are
  // the ones that sweep past the corners.
  vec2 c = (hash22(vec2(seed, fi)) - 0.5) * vec2(2.6 * aspect, 1.9);
  c.y += 0.30;

  vec3 tint = pal(fract(seed * 0.7 + 0.3));
  vec3 hot = mix(tint, vec3(1.0), 0.5);
  vec3 col = vec3(0.0);

  // Far shells are dimmer and cooler; the one at the lens runs hot.
  float atten = mix(0.40, 1.25, sat((ZFAR - z) / (ZFAR - ZNEAR)));

  // --- ascent -------------------------------------------------------------
  // A comet rising to the burst point, easing out as it runs out of thrust.
  const float RISE = 0.22;
  if (age < RISE) {
    float k = age / RISE;
    float ease = k * k * (3.0 - 2.0 * k);
    vec2 h = mix(vec2(c.x * 0.4, -1.9), c, ease) * s;
    vec2 q = uv - h;
    q.y *= 0.30;                       // stretch the falloff into a vertical streak
    float dh = length(q);
    col += hot * (0.0025 / (dh + 0.0025)) * (1.0 - k * 0.7) * 0.9 * atten;
  }

  // --- open shell ---------------------------------------------------------
  float bt = sat((age - RISE * 0.9) / (1.0 - RISE * 0.9));
  if (bt <= 0.0) return col;

  // pow 0.35 rather than sqrt: the shell has to be open before the eye can
  // resolve it, and any slower the burst spends its brightest frames as a
  // dense ball with the individual stars packed invisibly inside it.
  //
  // In world units, then projected - so a shell that is both open and close
  // genuinely overruns the frame instead of being clamped to a screen radius.
  float R = p_size * (0.25 + 0.75 * pow(bt, 0.35)) * (0.65 + 0.5 * seed2) * s;

  vec2 d = uv - c * s;
  d.y += bt * bt * p_gravity * 0.5 * s;   // the shell sags as it slows

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
  // A star is a fixed size in the world, so its screen width goes with depth -
  // except for a floor, below which a far shell would fall under a pixel and
  // alias into a ring of sparkle.
  float w = max(0.004, (0.008 + 0.016 * R / max(s, 1e-3)) * s);
  float ray = exp(-(arc * arc) / (w * w));

  // Radial profile: a hard head at the lane's radius with a soft tail trailing
  // back toward the centre - the streak the star has already flown through.
  float head = exp(-(max(0.0, r - rr) * max(0.0, r - rr)) / (w * w * 2.0));
  float tail = step(r, rr) * exp(-(rr - r) / (R * 0.30 + 1e-4));

  float spark = ray * (head + 0.55 * tail);
  // Per-star twinkle, on its own phase so the shell shimmers rather than pulses.
  spark *= 0.6 + 0.4 * sin(hash11(li + seed * 13.0) * 60.0 + t * 34.0);

  float fade = (1.0 - bt) * (1.0 - bt);
  col += hot * spark * fade * p_bright * atten;

  // The flash at detonation. Kept small and short: any longer and every shell
  // spends most of its life as a white ball with the stars lost inside it.
  col += hot * exp(-bt * 16.0) * exp(-(r * r) / ((0.002 + 0.03 * bt) * s * s)) * 1.4 * atten;

  // --- smoke --------------------------------------------------------------
  // The billow outlives the sparks and cools as it goes, so a burst leaves
  // something behind instead of simply switching off. It is also what makes the
  // overlaps read: two shells crossing share their smoke.
  float sr = max(R * 1.15, 1e-3);
  // Noise frequency clamped rather than tied to the shell's screen size. Scaling
  // it with the shell keeps the billow self-similar, which is right until a
  // shell arrives at the lens - then the fbm is sampled over a fraction of an
  // octave and the smoke flattens into one smooth plate.
  float nf = clamp(2.4 / sr, 1.6, 14.0);
  float n = fbm(d * nf + vec2(seed * 21.0, -t * 0.35), 4, 2.2, 0.55);
  // Wide falloff. At smoothstep(1.0, 0.1, ...) the billow *ends* at r = sr, and
  // on a shell close enough for that radius to cross the frame the ending is a
  // hard circular edge drawn across the sky.
  float body = smoothstep(1.35, 0.0, r / sr);
  // Soft threshold, not a clipped one. sat(x - 0.22) cuts the billow off wherever
  // it falls under the floor, and on a near shell that cut is a hard arc drawn
  // across a corner of the sky.
  float smoke = smoothstep(0.22, 0.78, body * (n * 1.6 + 0.3));
  float slife = smoothstep(0.0, 0.10, bt) * pow(1.0 - bt, 0.7);
  col += mix(hot, palClamp(0.45), bt) * smoke * slife * p_smoke * 2.2 * atten;

  // Wide halo, so the burst lights the air around it rather than ending at the
  // outermost star.
  col += tint * exp(-r / (R * 0.85 + 1e-3)) * fade * p_smoke * 0.4 * atten;

  return col;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * clamp(p_rate, 0.2, 3.0);

  // Night sky, brighter toward the horizon.
  vec3 col = mix(palClamp(0.16), palClamp(0.01), sat(uv.y * 0.45 + 0.5));

  // Stars on three planes, each closing on the camera and recycling.
  //
  // The shells travel; if the sky behind them does not, the eye reads the whole
  // thing as bursts scaled up and down on a backdrop rather than as a flight.
  // Three planes is enough for parallax - the near one sweeps past, the far one
  // barely moves - and the fade at each end of a plane's run means none of them
  // is ever seen being born.
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float ph = fract(uTime * 0.055 * clamp(p_flow, 0.0, 1.0) + fk * 0.3333);
    float pz = mix(3.4, 0.45, ph);
    float ps = FOCAL / pz;

    vec2 g = uv / ps * 9.0 + fk * 31.7;
    vec2 gi = floor(g);
    float sk = hash12(gi);
    vec2 gp = fract(g) - 0.5 - (hash22(gi) - 0.5) * 0.7;

    // In and out, so a plane arrives out of the haze and leaves past the lens.
    float life = smoothstep(0.0, 0.15, ph) * smoothstep(1.0, 0.80, ph);

    col += vec3(0.75, 0.8, 1.0) * smoothstep(0.9, 1.0, sk)
         * exp(-dot(gp, gp) * 70.0) * (0.35 + 0.65 * hash11(sk * 37.0)) * life;
  }

  int count = int(clamp(p_shells, 1.0, 10.0));
  for (int i = 0; i < 10; i++) {
    if (i >= count) break;
    col += shell(uv, float(i), t, uAspect);
  }

  // Everything the bursts add spills a little into the sky.
  col += palClamp(0.5) * sat(luma(col) - 0.35) * 0.35;

  fragColor = vec4(col, 1.0);
}
