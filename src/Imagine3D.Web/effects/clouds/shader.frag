#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Front-to-back raymarched cloud volume. Rather than a physical light transport,
// density itself drives the palette lookup - which is what makes it read as a
// demoscene cloudscape instead of a weather simulation.

float density(vec3 p, float t) {
  p.z += t * 0.6;
  p.y += sin(p.x * 0.4 + t * 0.3) * 0.3;
  float d = fbm3(p * 0.8, 5);

  // Carve a slab so the volume has a top and bottom rather than filling space.
  d -= 0.42 + 0.3 * abs(p.y * 0.6);

  // A hard-ish threshold rather than a linear ramp: without it the march
  // integrates a smooth haze everywhere and the result is featureless mush.
  d = smoothstep(0.0, 0.18, d);

  return clamp(d * 1.6 * p_density, 0.0, 1.0);
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  // Flying through the bank, not hovering in front of it. Held still, this
  // measured as the second-slowest effect in the library - the cloud evolved in
  // place, which over a twenty-second scene reads as a photograph with a bit of
  // shimmer on it. The volume is already sampled in world space, so a moving
  // origin is the whole of the fix.
  vec3 ro = vec3(sin(t * 0.13) * 1.2, sin(t * 0.09) * 0.6, -3.0 + t * p_drift);
  vec3 rd = normalize(vec3(uv, 1.35));

  // Slow drift so the camera never sits still.
  rd.xz = rot(sin(t * 0.4) * 0.25) * rd.xz;
  rd.yz = rot(sin(t * 0.31) * 0.12) * rd.yz;

  int steps = int(clamp(p_steps, 12.0, 96.0));
  float stepLen = 6.5 / float(steps);

  vec3 col = vec3(0.0);
  float trans = 1.0;   // remaining transmittance

  for (int i = 0; i < 96; i++) {
    if (i >= steps || trans < 0.02) break;
    float dist = 0.6 + float(i) * stepLen;
    vec3 p = ro + rd * dist;

    float d = density(p, t);
    if (d <= 0.001) continue;

    // Colour by density and depth, so the volume has internal structure.
    vec3 c = palClamp(0.12 + 0.75 * d + 0.1 * sin(dist * 0.3 + t));

    // Cheap self-illumination: denser regions glow rather than shadow, which
    // keeps the palette visible instead of collapsing to grey.
    c *= 0.5 + p_glow * d;

    float a = d * stepLen * 2.4;
    col += c * a * trans;
    trans *= 1.0 - a;
  }

  // Background gradient behind the volume.
  vec3 bg = mix(palClamp(0.05), palClamp(0.42), sat(uv.y * 0.5 + 0.5));
  col += bg * trans;

  col *= 0.9 + 0.35 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
