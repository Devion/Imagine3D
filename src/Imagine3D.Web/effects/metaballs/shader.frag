#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"
#include "sdf.glsl"

// Metaballs with a third dimension.
//
// The 2D version summed 1/d^2 over a handful of centres and contoured the
// result. That is the historically correct algorithm and it produces a picture
// of blobs rather than a picture of a room with blobs in it: everything sits on
// one plane, nothing passes in front of anything else, and the frame outside the
// cluster is dead. Roughly a fifth of the screen was ever lit.
//
// Sphere-tracing a smooth union of the same centres keeps every property that
// mattered - the merging, the pinching necks as two blobs part, the hard palette
// contours - and adds the ones the flat version could not have: occlusion,
// specular highlights that travel over a curved surface, and blobs close enough
// to the lens to fill the frame on their own. smin() is doing the same job the
// summed field did; it is just a distance rather than a potential, which is what
// lets a ray find it.
//
// The contour banding is applied to the *shading*, not to the field, so it still
// reads as a copper list rather than as a modern gradient.

float gCount, gSize, gSpread, gGoo, gTime;

/// Per-blob radius scale, one band each, low to high.
///
/// Held in a global filled once in main() rather than sampled inside map(),
/// because map() runs sixty-odd times per pixel and would otherwise re-read the
/// whole spectrum on every step of every ray for a value that cannot change
/// within a frame.
float gBandR[12];

vec3 blobAt(float i) {
  float f = i + 1.0;
  float s = hash11(f * 3.7);
  // Each blob rides its own lissajous figure, so they never form a pattern.
  return vec3(
    sin(gTime * (0.61 + s * 0.30) + f * 1.7),
    cos(gTime * (0.47 + s * 0.37) + f * 2.3),
    sin(gTime * (0.53 + s * 0.23) + f * 3.1)) * gSpread * (0.55 + 0.55 * s);
}

float map(vec3 p) {
  float d = 1e9;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= gCount) break;
    float r = gSize * (0.7 + 0.6 * hash11(float(i) + 3.0)) * gBandR[i];
    d = smin(d, length(p - blobAt(float(i))) - r, gGoo);
  }
  return d;
}

/// The wall behind everything: a full-frame field, so the gaps between blobs are
/// still part of the picture instead of holes in it.
vec3 backdrop(vec3 rd) {
  vec2 q = rd.xy / max(0.35, rd.z + 0.6) * 1.6;
  float v = 0.0;
  v += sin(q.x * 2.1 + gTime * 0.7);
  v += sin((q.y - gTime * 0.4) * 1.9);
  v += sin((q.x + q.y) * 1.4 + gTime * 0.5);
  v += sin(length(q * 1.3) * 2.2 - gTime * 0.9);
  v = v * 0.125 + 0.5;

  vec3 c = p_bands > 2.0 ? palSteps(v * 0.75 + 0.08, p_bands) : palClamp(v);
  return c * (0.52 + 0.18 * uBeatPulse);
}

void main() {
  gTime = uTime * p_speed;
  gCount = clamp(floor(p_count + 0.5), 2.0, 12.0);
  gSize = p_size;
  gSpread = p_spread;
  gGoo = max(0.02, p_goo);

  // A blob per band, low to high. The cluster then swells unevenly - the big
  // slow one on the kick, the small ones fluttering on the top end - so the mass
  // is being played rather than inflated.
  for (int i = 0; i < 12; i++)
    gBandR[i] = 0.62 + 0.70 * spectrumNow(float(i) / 11.0) + 0.30 * spectrumHit(float(i) / 11.0);

  vec2 uv = centered(vUv, uAspect);

  // Close in, and orbiting. The camera being inside the cluster's reach is the
  // whole difference between a mass of blobs and an object made of blobs.
  float orb = gTime * 0.23;
  float dist = p_distance * (1.0 - 0.06 * uBeatPulse);
  vec3 ro = vec3(sin(orb) * dist * 0.5, sin(orb * 0.7) * dist * 0.28, -dist);
  mat3 cam = lookAt(ro, vec3(0.0), sin(gTime * 0.13) * 0.15);
  vec3 rd = normalize(cam * vec3(uv, 1.5));

  vec3 col = backdrop(rd);

  int steps;
  float t = raymarch(ro, rd, dist * 2.6, 90, steps);

  if (t < dist * 2.6) {
    vec3 pos = ro + rd * t;
    vec3 n = calcNormal(pos, 0.0025);

    vec3 lightDir = normalize(vec3(-0.35, 0.72, -0.6));
    float diff = max(0.0, dot(n, lightDir));
    float fres = pow(1.0 - max(0.0, dot(n, -rd)), 3.0);
    float ao = ambientOcclusion(pos, n);

    // The contour. Depth through the cluster plus facing angle, quantised - the
    // same quantity the flat version banded, read off a surface instead of off a
    // potential field.
    float shade = sat(diff * 0.75 + fres * 0.5 + 0.18);
    vec3 body = p_bands > 2.0 ? palSteps(shade * 0.92, p_bands) : palClamp(shade);

    body *= 0.35 + 0.85 * ao;

    // Specular, deliberately tight: it is the one thing that says the surface is
    // curved rather than painted.
    vec3 h = normalize(lightDir - rd);
    body += vec3(1.0) * pow(max(0.0, dot(n, h)), 48.0) * 0.85;

    // Rim, and a little of the backdrop refracted through the edges, so a blob
    // reads as a body of something rather than as a solid.
    body += palClamp(0.92) * fres * 0.55;
    body = mix(body, backdrop(normalize(refract(rd, n, 0.86) + vec3(0.0, 0.0, 0.2))) * 2.2,
               fres * 0.35 * p_glass);

    // Fog into the backdrop, so far blobs join the wall instead of ending on it.
    col = mix(body, col, smoothstep(dist * 0.9, dist * 2.4, t));
  }

  // Light bleeding out of the mass, gathered from how close the ray ran to it.
  col += palClamp(0.9) * pow(1.0 - float(steps) / 90.0, 6.0) * 0.20 * p_bleed;

  col *= 0.92 + 0.28 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
