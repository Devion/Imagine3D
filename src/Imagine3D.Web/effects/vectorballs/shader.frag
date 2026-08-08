#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"

// Vector balls, opened out into a corridor.
//
// The technique is unchanged and is the whole point of the effect: every ball is
// a sprite, shaded from its own disc as if it were a sphere, and the nearest one
// wins the pixel. That is exactly what the Amiga did, resolved per fragment
// instead of per blit.
//
// What changed is the framing. One formation of 28 balls hanging in the middle
// of a black frame is how a 1990 demo framed it, on a 14-inch monitor. Projected
// behind a band it is a small object with a lot of nothing around it, and a VJ
// set spends most of its time looking at the nothing. So the camera flies *down*
// a stack of rings of them instead: the near balls are metres across and blow
// past the corners, the far ones converge on a vanishing point, and the frame is
// full from edge to edge the whole way through.
//
// Sorting still costs nothing. Rings are visited near-to-far, so the first ball
// that covers a pixel is the nearest one that can and the loop leaves early -
// which is what pays for twelve times as many balls as the original drew.

const float PITCH = 1.15;   // world spacing between rings

/// Where ring `k` sits, given how far we have travelled. Ring 0 is the one just
/// in front of the camera; higher k is further away.
float ringDepth(float k, float travel) {
  return 0.55 + PITCH * (k + fract(-travel / PITCH));
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float rad = length(uv);

  float travel = uTime * p_speed;
  float spin = uTime * p_spin;

  // ---- the corridor the balls hang in ------------------------------------
  // Never flat black: a haze down the throat plus a slow drift of cloud, so the
  // gaps between balls read as distance rather than as holes in the picture.
  vec3 col = palClamp(0.04 + 0.22 * exp(-rad * 1.1)) * 0.55;
  col += palClamp(0.30) * fbm(uv * 1.3 + vec2(0.0, travel * 0.05), 4, 2.0, 0.5) * 0.09;
  col += palClamp(0.85) * exp(-rad * 3.2) * (0.10 + 0.22 * uBeatPulse) * p_haze;

  // Radial spokes converging on the vanishing point. Cheap, and it is what makes
  // the throat read as a corridor before a single ball is drawn.
  float spokes = 0.5 + 0.5 * sin(atan(uv.y, uv.x) * 12.0 + spin * 2.0);
  col += palClamp(0.55) * spokes * exp(-rad * 2.2) * 0.07;

  float per = clamp(floor(p_count + 0.5), 4.0, 20.0);
  float rings = clamp(floor(p_rings + 0.5), 4.0, 22.0);

  // Balls swell on the beat, and the ring radius breathes with the low end, so
  // the corridor opens and closes rather than the balls merely flashing.
  float open = p_spread * (1.0 + 0.16 * uBass + 0.10 * uBeatPulse);

  bool hit = false;

  for (int k = 0; k < 22; k++) {
    if (float(k) >= rings || hit) break;
    float fk = float(k);

    float z = ringDepth(fk, travel);
    if (z < 0.12) continue;

    // Which ring this actually is in world terms - the index has to survive the
    // recycling or every ring would change its identity as the stack scrolls,
    // and the corkscrew would jitter once per pitch.
    float id = floor(travel / PITCH) + fk;

    // Each ring answers a different part of the spectrum: the one in your face
    // is the low end, the vanishing point is the top. The corridor becomes an
    // analyser you fly down rather than one formation pumping on the beat, and
    // because the band is taken from the ring's *place* in the stack rather
    // than its identity, the reading holds still while the rings scroll past.
    float bandX = rings > 1.0 ? fk / (rings - 1.0) : 0.0;
    float band = spectrumNow(bandX);

    float scale = 2.0 / z;
    float ringR = open * (0.85 + 0.35 * sin(id * 0.41)) * (0.86 + 0.28 * band);
    float roll = spin * 0.6 + id * p_twist;

    // A ring whose whole projected disc misses this pixel cannot contain the
    // ball that covers it. One length() throws out the rest of the ring.
    float ballR = p_radius * scale * (0.72 + 0.55 * band);
    if (abs(rad - ringR * scale) > ballR + 1e-3) continue;

    for (int i = 0; i < 20; i++) {
      if (float(i) >= per) break;
      float a = (float(i) + 0.5) / per * TAU + roll;

      vec2 sp = vec2(cos(a), sin(a)) * ringR * scale;
      vec2 d = uv - sp;
      float dist = length(d);
      if (dist > ballR) continue;

      // Sphere normal from the sprite's own disc, so it shades like geometry.
      float kz = sqrt(max(0.0, 1.0 - (dist / ballR) * (dist / ballR)));
      vec3 normal = vec3(d / ballR, kz);

      vec3 lightDir = normalize(vec3(-0.35, 0.55, 0.76));
      float diff = max(0.0, dot(normal, lightDir));
      float spec = pow(max(0.0, dot(normal, normalize(lightDir + vec3(0.0, 0.0, 1.0)))), 40.0);

      // Colour runs around the ring and along the corridor at once, so the
      // stack is a moving gradient rather than a repeating pattern.
      vec3 base = pal(fract(float(i) / per * 0.7 + id * 0.055 + uTime * 0.04));
      vec3 ball = base * (0.16 + 0.95 * diff) + vec3(spec) * 0.85;

      // Rim, which is what separates two balls that overlap in screen space.
      ball += base * pow(1.0 - kz, 3.0) * 0.55;

      // Depth. Near balls run hot and blow out slightly, far ones sink into the
      // corridor haze rather than going black, so the stack has no visible end.
      ball *= mix(1.5, 0.55, sat((z - 0.6) / 7.0));
      ball = mix(ball, palClamp(0.18) * 0.5, smoothstep(4.0, 13.0, z));

      col = ball;
      hit = true;
      break;
    }
  }

  col *= 0.92 + 0.28 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
