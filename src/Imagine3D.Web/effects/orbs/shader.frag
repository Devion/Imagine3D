#include "common.glsl"
#include "palette.glsl"
#include "sdf.glsl"

// Orbs arranged around a ring that recedes into a funnel.
//
// The orbs are placed by *domain repetition* in cylindrical coordinates rather
// than by looping over a list, so the count is free: one distance evaluation
// covers every orb in the field, and the ring can extend to the horizon.

float gWormhole, gCount, gRadius, gSpin, gSpeed;

const float RING_PITCH = 1.15;   // spacing between rings down the tunnel

float map(vec3 p) {
  // Coordinate that travels down the tunnel with time.
  float travel = p.z + gSpeed * uTime;

  // Which copy of the ring this point belongs to, and how far it sits from it.
  // In ring mode there is exactly one ring at z = 0, so the offset is simply
  // p.z; in wormhole mode the rings repeat along the tunnel.
  float zRepeat = mod(travel + RING_PITCH * 0.5, RING_PITCH) - RING_PITCH * 0.5;
  float dz = mix(p.z, zRepeat, gWormhole);

  // Ring radius narrows with depth once it is a funnel. Measured from the
  // *repeated* coordinate so every ring in the tunnel gets its own radius.
  float depth = mix(0.0, abs(travel), gWormhole);
  float ring = mix(0.85, 0.85 / (1.0 + depth * 0.16), gWormhole);

  // Twist grows with depth so the funnel corkscrews.
  float twist = gSpin * uTime + travel * gWormhole * 0.35;

  float a = atan(p.y, p.x) + twist;
  float r = length(p.xy);

  // Polar domain repetition: fold the angle into one sector, then rotate the
  // point into that sector's frame so the orb can be placed at a fixed offset.
  float seg = TAU / max(3.0, gCount);
  float local = mod(a + seg * 0.5, seg) - seg * 0.5;
  vec2 q = vec2(cos(local), sin(local)) * r;

  float orb = length(vec3(q.x - ring, q.y, dz)) - gRadius;

  // A faint spine down the middle gives the wormhole a centre to read against.
  // Pushed far away in ring mode so it contributes nothing there.
  float spine = (length(p.xy) - 0.035) + (1.0 - gWormhole) * 20.0;

  return min(orb, spine);
}

void main() {
  gWormhole = clamp(p_wormhole, 0.0, 1.0);
  gCount = p_count;
  gRadius = p_radius;
  gSpin = p_spin;
  gSpeed = p_speed;

  vec2 uv = centered(vUv, uAspect);

  // Pull the camera back for the ring, push it inside for the wormhole.
  float dist = mix(3.2, 1.1, gWormhole);
  vec3 ro = vec3(0.0, 0.0, -dist);
  vec3 rd = normalize(vec3(uv, 1.4));

  // A gentle drift so a static ring still has parallax.
  float bob = (1.0 - gWormhole) * 0.25;
  ro.xy += vec2(sin(uTime * 0.4), cos(uTime * 0.31)) * bob;
  rd.xy = rot(sin(uTime * 0.17) * 0.15 * (1.0 - gWormhole)) * rd.xy;

  int steps;
  float t = raymarch(ro, rd, 26.0, int(clamp(p_steps, 24.0, 160.0)), steps);

  vec3 col;
  if (t < 26.0) {
    vec3 pos = ro + rd * t;
    vec3 n = calcNormal(pos, 0.0025);

    vec3 lightDir = normalize(vec3(0.5, 0.7, -0.5));
    float diff = max(0.0, dot(n, lightDir));
    float fres = pow(1.0 - max(0.0, dot(n, -rd)), 4.0);
    float ao = ambientOcclusion(pos, n);

    // Colour by angle around the tunnel so neighbouring orbs differ.
    float hue = atan(pos.y, pos.x) / TAU + 0.5 + uTime * 0.03;
    vec3 base = pal(fract(hue));

    col = base * (0.14 * ao + 0.9 * diff);

    // Glossy highlight - these are meant to look like polished spheres.
    vec3 h = normalize(lightDir - rd);
    col += vec3(1.0) * pow(max(0.0, dot(n, h)), 64.0) * 0.9;
    col += palClamp(0.92) * fres * 0.7;

    col = mix(col, palClamp(0.04), smoothstep(6.0, 22.0, t));
  } else {
    col = mix(palClamp(0.16), palClamp(0.02), length(uv) * 0.7);
  }

  // Glow down the throat of the wormhole.
  float throat = exp(-length(uv) * 3.5) * gWormhole;
  col += palClamp(0.9) * throat * (0.5 + 0.8 * uBeatPulse);

  col *= 0.92 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
