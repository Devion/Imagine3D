#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// A cyclone seen slightly from above.
//
// The trick that makes it swirl rather than spin is differential rotation: the
// sample point is rotated by an angle that falls off as 1/r, so the inner bands
// run ahead of the outer ones and the noise shears into arms. Rotating rigidly
// gives you a turntable, not a storm.
//
// The eye is a hole punched in the density, not a painted disc, so the wall
// around it keeps its volume and casts into itself.

float density(vec3 p, float t) {
  float r = length(p.xy);

  float a = p_swirl * 2.4 / (r + 0.45) + t * 0.5;
  p.xy = rot(a) * p.xy;

  float d = fbm3(p * 0.95 + vec3(0.0, 0.0, t * 0.2), 5);

  // Slab, so the storm has a thickness instead of filling the frustum.
  d -= 0.40 + 0.36 * abs(p.z);

  // A threshold rather than a ramp: integrating a linear haze everywhere gives
  // an even grey, and the billow edges are the whole point. Widening it past
  // about 0.25 takes the edges back off and the arms shred into wisps.
  d = smoothstep(0.0, 0.22, d);

  d *= smoothstep(0.0, 0.9, r - p_eye);   // eye
  d *= smoothstep(4.6, 2.6, r);           // outer rim

  return clamp(d * p_density, 0.0, 1.0);
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  vec3 ro = vec3(0.0, -1.5, -4.4);
  vec3 rd = normalize(vec3(uv, 1.25));

  // Tilt down onto the disc, then orbit slowly so the arms sweep past.
  const float pitch = 0.42;
  ro.yz = rot(pitch) * ro.yz;
  rd.yz = rot(pitch) * rd.yz;
  float yaw = t * 0.07;
  ro.xz = rot(yaw) * ro.xz;
  rd.xz = rot(yaw) * rd.xz;

  int steps = int(clamp(p_steps, 16.0, 96.0));
  float stepLen = 9.5 / float(steps);

  vec3 L = normalize(vec3(0.45, 0.72, -0.55));

  vec3 col = vec3(0.0);
  float trans = 1.0;   // remaining transmittance

  for (int i = 0; i < 96; i++) {
    if (i >= steps || trans < 0.02) break;
    float dist = 0.4 + (float(i) + hash12(gl_FragCoord.xy) * 0.85) * stepLen;
    vec3 p = ro + rd * dist;

    float d = density(p, t);
    if (d <= 0.002) continue;

    // Three taps toward the light. The volume is soft, so more taps only cost
    // frames; what matters is that the far side of a billow goes dark at all.
    float sh = density(p + L * 0.30, t) * 0.55
             + density(p + L * 0.70, t) * 0.30
             + density(p + L * 1.30, t) * 0.15;
    float lit = exp(-sh * p_shade * 3.2);

    // Palette height comes from light, not density, so the sunlit face of each
    // billow walks up the ramp while the shadow side sits at the dark end.
    vec3 c = palClamp(0.06 + 0.62 * lit + 0.12 * d);
    c += palClamp(0.95) * pow(lit, 6.0) * p_glow * 0.3;

    float a = clamp(d * stepLen * 3.0, 0.0, 1.0);
    col += c * a * trans;
    trans *= 1.0 - a;
  }

  // Sky behind the storm. Kept dark and unsaturated on purpose: at anything
  // brighter it competes with the cloud it is meant to sit behind, and the whole
  // frame flattens into one colour.
  vec3 sky = mix(palClamp(0.015), palClamp(0.20), sat(uv.y * 0.35 + 0.5));
  sky += palClamp(0.85) * 0.22 * pow(sat(1.0 - length(uv - vec2(0.35, 0.45)) * 0.5), 8.0);
  col += sky * trans;

  col *= 0.92 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
