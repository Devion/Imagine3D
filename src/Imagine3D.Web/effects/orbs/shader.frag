#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "sdf.glsl"

// Orbs arranged around a ring that recedes into a funnel.
//
// The orbs are placed by *domain repetition* in cylindrical coordinates rather
// than by looping over a list, so the count is free: one distance evaluation
// covers every orb in the field, and the ring can extend to the horizon.

float gWormhole, gCount, gRadius, gSpin, gSpeed, gSpread;

const float RING_PITCH = 1.9;    // spacing between rings down the tunnel

float map(vec3 p) {
  // Coordinate that travels down the tunnel with time. Only ever used to decide
  // *which* ring copy a point falls in - never to size or twist anything, see
  // below.
  float travel = p.z + gSpeed * uTime;

  // Which copy of the ring this point belongs to, and how far it sits from it.
  // In ring mode there is exactly one ring at z = 0, so the offset is simply
  // p.z; in wormhole mode the rings repeat along the tunnel.
  float zRepeat = mod(travel + RING_PITCH * 0.5, RING_PITCH) - RING_PITCH * 0.5;
  float dz = mix(p.z, zRepeat, gWormhole);

  // Ring radius narrows with distance AHEAD OF THE CAMERA.
  //
  // This used to narrow with `travel`, which carries the elapsed-time term - so
  // the funnel kept shrinking for as long as the scene ran and collapsed to a
  // pinhole after half a minute, with everything appearing to rush past it. The
  // geometry has to be a function of position, not of how long we have been
  // looking at it.
  // Ring mode used to sit at 0.85 with the camera three units back, which put a
  // small hoop of orbs in the middle of an empty frame - the one state of this
  // effect that read as an object rather than as a place. Wide enough now that
  // the ring passes outside the frame edges and the camera is inside it.
  float depth = mix(0.0, max(0.0, p.z), gWormhole);
  float ring = mix(gSpread, gSpread * 0.62 / (1.0 + depth * 0.16), gWormhole);

  // Corkscrew with depth, plus a steady rotation. Again p.z, not travel: using
  // travel made the twist rate accelerate the longer the scene ran.
  float twist = gSpin * uTime + p.z * gWormhole * 0.35;

  float a = atan(p.y, p.x) + twist;
  float r = length(p.xy);

  // Polar domain repetition: fold the angle into one sector, then rotate the
  // point into that sector's frame so the orb can be placed at a fixed offset.
  float seg = TAU / max(3.0, gCount);
  float local = mod(a + seg * 0.5, seg) - seg * 0.5;
  vec2 q = vec2(cos(local), sin(local)) * r;

  float orb = length(vec3(q.x - ring, q.y, dz)) - gRadius;

  // A faint spine down the middle gives the wormhole a centre to read against.
  //
  // It must exist only *ahead* of the camera. The camera flies down the axis, so
  // an unbounded rod puts it permanently inside the geometry: map() returns a
  // negative value at the very first step, the march terminates immediately and
  // the whole frame collapses to fog. Intersecting with the z > 0 half-space
  // keeps it in front where it belongs.
  float spine = max(length(p.xy) - 0.035, -p.z + 0.4);
  spine += (1.0 - gWormhole) * 20.0;   // absent in ring mode

  return min(orb, spine);
}

void main() {
  gWormhole = clamp(p_wormhole, 0.0, 1.0);
  gCount = p_count;
  gRadius = p_radius;
  gSpin = p_spin;
  gSpeed = p_speed;
  gSpread = p_spread;

  vec2 uv = centered(vUv, uAspect);

  // Pull the camera back for the ring, push it inside for the wormhole.
  //
  // The range is deliberately modest. A 3.2 -> 1.1 dolly is a 3x zoom, and
  // because it happens over the same window as the shape morph the middle of
  // every scene turned into the most violent part of it by a wide margin.
  float dist = mix(2.1, 1.6, gWormhole);
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
    // Deep space, not a grey card. Orbs are sparse by construction - there is
    // as much sky as there is geometry - so what fills the gaps between them
    // decides whether the frame reads as full or as mostly empty.
    vec2 sky = uv * 0.8 + vec2(uTime * 0.01, 0.0);
    float dust = fbm(sky * 1.5, 5, 2.1, 0.55);
    col = mix(palClamp(0.20), palClamp(0.01), sat(length(uv) * 0.55));
    col += palClamp(0.30 + 0.5 * dust) * smoothstep(0.35, 0.9, dust) * 0.30;

    float star = step(0.9968, hash12(floor(uv * 130.0)));
    col += palClamp(0.95) * star * (0.5 + 0.5 * sin(uTime * 3.0 + hash12(floor(uv * 130.0)) * 40.0)) * 0.8;
  }

  // Glow down the throat of the wormhole.
  float throat = exp(-length(uv) * 3.5) * gWormhole;
  col += palClamp(0.9) * throat * (0.5 + 0.8 * uBeatPulse);

  col *= 0.92 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
