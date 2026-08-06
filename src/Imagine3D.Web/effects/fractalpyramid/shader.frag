#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Folded-space fractal, drawn by accumulating glow along the ray instead of
// stopping at the first hit.
//
// The distance estimator is the classic octahedral fold: rotate, mirror into the
// positive octant, translate, repeat. dot(sign(p), p) is a cheap octahedron
// bound, and folding it a few times turns one octahedron into a pyramid fractal.
//
// Marching *through* it and summing 1/d makes the interior visible - a normal
// surface render of this shape reads as a grey lump, because all the interest is
// in the layers behind the first hit.
//
// Technique reference: the "fractal pyramid" shader on Shadertoy.
//
// A note on framing, because it has now been got wrong four different ways and
// the constraint is not obvious. The folded bound never reaches zero - near the
// origin it settles around 0.3 and stays there - so there is no surface here to
// sphere-trace to and no normal to shade. The image is the glow integral and
// nothing else, and that only has contrast while most rays in the frame *miss*.
// Move the camera in to fill the screen and every ray grazes structure for its
// whole length, the integral saturates everywhere at once, and the frame comes
// back as a flat wash with the fractal invisible inside it. Zooming with a long
// lens keeps the wash and loses the parallax; repeating the lattice and flying
// through it leaves no detail, because the estimator is too smooth; and swapping
// in a Sierpinski field that does have a surface renders as glitter, because the
// limit set is thinner than a pixel at every scale.
//
// So the framing here is a compromise rather than a fix: closer and longer than
// it was, which roughly triples how much of the frame the structure covers, plus
// a lit backdrop so the rest of it is a place rather than a hole. It is still
// the most centred effect in the library. If it ever needs to go, note that
// sixteen storyboards in projects/ name it and would render those scenes black.

float gFolds, gSpin;

float map(vec3 p) {
  int folds = int(clamp(gFolds, 2.0, 14.0));
  for (int i = 0; i < 14; i++) {
    if (i >= folds) break;
    float t = uTime * gSpin;
    p.xz = rot(t) * p.xz;
    p.xy = rot(t * 1.89) * p.xy;
    p.xz = abs(p.xz);
    p.xz -= 0.5;
  }
  return dot(sign(p), p) / 5.0;
}

void main() {
  gFolds = p_folds;
  gSpin = p_spin;

  vec2 uv = centered(vUv, uAspect) * 0.5;

  // Orbit the whole structure, drifting off axis so it is not pinned to the
  // middle of the frame for a whole scene.
  vec3 ro = vec3(0.0, 5.0 * sin(uTime * 0.07), -30.0);
  ro.xz = rot(uTime * p_orbit) * ro.xz;

  vec3 fwd = normalize(-ro);
  vec3 side = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = normalize(cross(fwd, side));

  // Breathes between about 9 and 13 units across the frame, against a structure
  // roughly 4 across. Longer than this and the wash described above starts.
  float zoom = 5.0 + 0.9 * sin(uTime * 0.11) + 0.3 * uBeatPulse;
  vec3 rd = normalize(fwd * zoom + uv.x * side + uv.y * up);

  // Deep space rather than a void. Faint - the glow below is measured in
  // hundredths, so a backdrop of any real weight simply becomes the picture -
  // but enough that the corners of the frame carry something.
  vec3 col = mix(palClamp(0.20), palClamp(0.01), sat(length(uv) * 1.4)) * 0.10;
  col += palClamp(0.50) * fbm(uv * 2.2 + vec2(uTime * 0.015, 0.0), 5, 2.1, 0.55) * 0.05;
  float star = pow(sat(sin(rd.x * 150.0) * sin(rd.y * 150.0) * sin(rd.z * 150.0)), 45.0);
  col += palClamp(0.95) * star * 0.7;

  float t = 0.0;
  float d = 1.0;

  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    d = map(p) * 0.5;
    if (d < 0.02 || t > 120.0) break;

    // Glow falls off with the distance estimate, so grazing the surface lights
    // up and passing far from it contributes almost nothing.
    col += palClamp(fract(length(p) * 0.06 + uTime * 0.02)) / (400.0 * d);
    t += d;
  }

  col *= p_glow;

  // Tone-map: the accumulation is unbounded and would clip to white otherwise.
  col = col / (1.0 + col);
  col = pow(col, vec3(0.85));

  col *= 0.9 + 0.35 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
