#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Ink released into still water.
//
// Each bloom is a disc whose boundary radius varies with bearing, and the amount
// of that variation grows with the bloom - so a drop starts nearly round and
// grows into tendrils, which is the order real diffusion does it in. Spreading on
// pow(k, 0.45) rather than linearly is the other half: fast at release, then a
// long creep.

// The field a bloom's boundary is carved out of.
//
// Sampled in a cylinder: the two circular axes carry the bearing, so the noise
// wraps at 0/TAU with no seam - a seam here reads as a slit cut clean through the
// blob and there is no hiding it - while the third axis carries radius, scaled
// down so features stretch a long way outward. That anisotropy is the whole
// trick: isotropic noise on the boundary gives a wobbly circle, and stretched
// noise gives fingers.
float inkField(vec2 d, float R, float seed) {
  float r = length(d) / max(R, 1e-3);
  float th = atan(d.y, d.x);
  vec3 q = vec3(cos(th) * 2.4, sin(th) * 2.4, r * 0.85) + seed * 13.0;

  // A finer, weaker pass over the same field, so the front breaks into
  // filaments rather than ending on one clean contour.
  return mix(fbm3(q, 5), fbm3(q * 3.1 + 7.0, 3), 0.3);
}

float dropMask(vec2 d, float R, float feather, float grow, float seed) {
  // The variation is scaled by `grow`, so a drop is nearly round at release and
  // grows into its tendrils. Doing it the other way round - full detail from the
  // first frame - looks like a stain fading up, not ink spreading.
  float edge = R * (0.82 + grow * 1.45 * (inkField(d, R, seed) - 0.5));
  return smoothstep(edge, edge - feather * R - 1e-4, length(d));
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  // Warp the plane the blooms are measured in, not the blooms themselves: one
  // field moving everything together reads as water, whereas warping each drop
  // separately reads as each drop wobbling.
  float a = fbm(uv * 1.2 + vec2(0.0, t * 0.09), 4, 2.1, 0.55);
  float b = fbm(uv * 1.2 + vec2(4.7, -t * 0.07) + 3.1, 4, 2.1, 0.55);
  vec2 w = uv + (vec2(a, b) - 0.5) * p_flow;

  vec3 col = mix(palClamp(0.11), palClamp(0.01), sat(length(uv) * 0.55));

  int count = int(clamp(p_drops, 1.0, 8.0));
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    float fi = float(i);

    float ph = t / 5.5 + fi * 0.2137;
    float k = fract(ph);
    float seed = hash11(floor(ph) * 23.1 + fi * 9.4);

    vec2 c = (hash22(vec2(seed, fi + 0.5)) - 0.5) * vec2(2.0 * uAspect, 1.7);

    float grow = pow(k, 0.45);
    float R = p_spread * (0.15 + 0.85 * grow) * (0.6 + 0.7 * hash11(seed * 7.7));

    vec2 d = w - c;
    float m = dropMask(d, R, p_feather, grow, seed);
    if (m <= 0.002) continue;

    float life = smoothstep(0.0, 0.06, k) * smoothstep(1.0, 0.55, k);

    // Never the top stop of the ramp: that is white in most palettes, and a
    // white drop under a screen composite blows the frame out the moment two
    // of them cross.
    vec3 ink = pal(0.12 + 0.64 * fract(seed * 0.8 + 0.25));

    // Denser at the front than in the middle. Solute piling up at the edge of a
    // wet patch is the band that makes ink look like ink rather than airbrush.
    float ring = smoothstep(0.02, 0.30, m) * smoothstep(0.95, 0.45, m);

    // Streaks through the body, so the inside is pigment in motion rather than
    // a filled shape.
    float body = 0.35 + 0.8 * fbm(d * (3.4 / max(R, 1e-3)) + seed * 7.0, 4, 2.2, 0.55);

    // Screen, so overlaps stack as pigment instead of the newer drop simply
    // hiding the older one.
    vec3 add = sat(ink * (body + 1.1 * ring) * m * life * p_ink * 0.85);
    col = 1.0 - (1.0 - col) * (1.0 - add);
  }

  // Suspended grain, so the water is not a flat field between the blooms.
  col *= 0.93 + 0.07 * valueNoise(uv * 220.0 + t);
  col *= 0.9 + 0.3 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
