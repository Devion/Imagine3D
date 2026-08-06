#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Hyperspace: stars, warp streaks and the cloud they are flying through.
//
// The stars are unchanged and the reason is worth keeping written down. They
// live in a polar lattice indexed by (sector, shell) where the shell coordinate
// is 1/radius. Advancing that coordinate with time moves a star from the centre
// out to the frame edge along a straight line, forever - there is no per-layer
// depth counter to wrap. An earlier version cycled each layer's depth with
// fract() and rescaled its whole grid on the wrap, so every layer repopulated
// several times a second and the effect read as constant popping rather than as
// travel. Nothing here resets.
//
// What is new is everything around them. Points of light on black light about
// seven percent of a frame, which is a screensaver, not a scene: there was
// nothing at the edges, nothing to grade, and nothing for a transition to hold
// on to. So the same travel coordinate now also drives a volume of cloud drawn
// in the same perspective, streaks that stretch with the speed, and a core the
// whole field converges on. All four share one `travel`, so they can never
// disagree about which way the camera is going.

/// Cloud density at screen radius r, along the ray. Sampled at a few depths
/// rather than marched: the field is smooth and the perspective does the rest.
vec3 nebula(vec2 uv, float travel) {
  vec3 acc = vec3(0.0);

  // Three shells at different depths. Dividing uv by the shell distance is the
  // perspective divide, so the near shell is a big soft wash and the far one is
  // fine structure converging on the centre - which is what gives a flat noise
  // field somewhere to be.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float z = 0.55 + fi * 0.85;
    vec2 q = uv / z + vec2(fi * 17.3, fi * 5.1);

    float n = fbm(q * 1.15 + vec2(0.0, travel * 0.030 / z), 5, 2.1, 0.55);
    // Ridged, so the cloud has filaments and dark lanes instead of being an even
    // grey. Dust lanes are most of what makes a nebula read as a nebula.
    float ridge = 1.0 - abs(n * 2.0 - 1.0);
    float d = smoothstep(0.28, 0.95, n) * (0.35 + 0.85 * ridge * ridge);

    acc += palClamp(0.16 + 0.62 * fract(n * 1.7 + fi * 0.3)) * d / (1.0 + fi * 0.9);
  }

  return acc;
}

void main() {
  vec2 uv = centered(vUv, uAspect);

  // Barrel warp, kept subtle - this used to lurch on every downbeat.
  uv *= 1.0 + p_warp * dot(uv, uv) * 0.12;

  float r = length(uv);
  float a = atan(uv.y, uv.x) / TAU + 0.5;   // 0..1 around the frame

  // Travel. Mostly forward, occasionally easing backwards and returning: the
  // sine term is what makes it roll back, and it only wins over the linear term
  // for part of each slow cycle, so a reversal is an event rather than a wobble.
  float travel = uTime * p_speed
               + p_rollback * 2.4 * sin(uTime * p_rollRate);

  // ---- the cloud the field is flying through ------------------------------
  vec3 col = nebula(uv, travel) * p_nebula;

  // Everything converges on one point, so put something there. It is also what
  // stops the middle of the frame going dark as the stars leave it.
  col += palClamp(0.92) * exp(-r * 3.4) * (0.22 + 0.45 * uBeatPulse) * p_core;
  col += palClamp(0.55) * exp(-r * 1.1) * 0.10;

  // ---- warp streaks --------------------------------------------------------
  // Long light trails drawn straight in polar coordinates. Separate from the
  // stars because they answer a different question: the stars say where things
  // are, the streaks say how fast. They stretch with the music, so a chorus
  // genuinely accelerates rather than merely brightening.
  float warpAmt = p_warpLines * (0.25 + 0.9 * uEnergy + 0.5 * uRms);
  if (warpAmt > 0.01) {
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      float sectors = floor(64.0 + fi * 41.0);
      float ai = a * sectors + hash11(fi * 3.1) * sectors;
      float lane = floor(ai);
      float across = (fract(ai) - 0.5) * (TAU / sectors) * r;

      float s = hash11(lane * 1.7 + fi * 91.0);
      if (s < 0.86) continue;

      // Each streak occupies a band of radius that slides outward with travel.
      float phase = fract(travel * (0.10 + 0.06 * s) + s * 13.0);
      float head = phase * 2.9;
      float len = 0.35 + 1.1 * warpAmt * (0.5 + s);
      float along = smoothstep(head - len, head - len * 0.15, r) * smoothstep(head, head - 0.04, r);

      float w = 0.0016 + 0.010 * r;
      float line = exp(-abs(across) / w) * along;

      col += palClamp(0.6 + 0.4 * s) * line * 0.55 * warpAmt;
    }
  }

  // ---- the stars ----------------------------------------------------------
  vec3 stars = vec3(0.0);
  int layers = int(clamp(p_layers, 3.0, 7.0));

  for (int i = 0; i < 7; i++) {
    if (i >= layers) break;
    float fi = float(i);

    // Integer sector count so the lattice wraps cleanly at the seam.
    float sectors = floor(13.0 + fi * 8.0);
    float layerSpeed = 0.35 + fi * 0.28;

    // Shell coordinate. Stars sit at integer shells; a star at shell k is drawn
    // where 1/r + travel = k, so as travel grows r grows - outward.
    float w = 1.0 / max(r, 0.02) + travel * layerSpeed + fi * 31.7;

    // Offset each shell's sector boundaries by a per-shell amount. Without this
    // every shell shares the same angular grid and the stars line up into
    // visible radial spokes - a sunburst rather than a sky.
    float shell = floor(w);
    float ai = a * sectors + hash11(shell + fi * 5.7) * sectors;

    vec2 cell = vec2(mod(floor(ai), sectors), shell);
    vec2 f = vec2(fract(ai), fract(w));

    float bright = hash12(cell + fi * 17.1);
    if (bright < 1.0 - p_density / 200.0) continue;

    vec2 jit = hash22(cell + fi * 71.3) * 0.7 + 0.15;

    // Offsets from the star's centre, converted from lattice units to screen
    // units. d(1/w) = -dw / w^2 = -dw * r^2, which is what makes stars grow as
    // they approach the edge without any explicit size ramp.
    float dA = (f.x - jit.x) * (TAU / sectors) * r;

    // r*r is the exact derivative of 1/w, but it grows without bound and turned
    // stars near the frame edge into long comets. Clamped, they stay stars -
    // and the elongation the speed asks for is added deliberately below.
    float dW = (f.y - jit.y) * min(r * r, 0.35);

    // Radial elongation. Grows with the streak parameter and with the music, so
    // the field genuinely stretches into lines when the track opens up.
    float stretch = 1.0 + (p_streak + 0.55 * warpAmt) * 4.5;
    float d = length(vec2(dA, dW / stretch));

    float glow = 0.005 / (d + 0.005);
    float star = pow(glow, 1.7) * (0.35 + bright * 0.8);

    // Fade in as a star is born at the centre and out only once it is past the
    // corner. centered() puts the corner at r ~2.0 on 16:9, so fading from 1.1
    // left the outer frame permanently black.
    star *= smoothstep(0.0, 0.09, r) * smoothstep(2.9, 2.2, r);

    stars += palClamp(0.55 + 0.45 * hash11(bright * 91.0)) * star;
  }

  col += stars * 1.5;

  // Gentle: a hard beat flash on a full-frame starfield is a strobe.
  col *= 0.94 + 0.14 * uBeatPulse;

  // The sum of a cloud, streaks and unbounded star glows has no ceiling; roll it
  // off rather than clipping, or the core comes out as a flat white disc.
  col = col / (1.0 + col * 0.30);
  fragColor = vec4(max(col, 0.0), 1.0);
}
