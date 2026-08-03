#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Branching arcs.
//
// Each bolt is a straight segment whose perpendicular offset is driven by fBm,
// so the path jitters like a discharge. Distance to that displaced line, fed
// through an inverse falloff, gives the hot core and the wide halo in one term.

float boltDistance(vec2 p, vec2 a, vec2 b, float jag, float seed, float t) {
  vec2 ab = b - a;
  float len = length(ab);
  vec2 dir = ab / max(len, 1e-5);
  vec2 nrm = vec2(-dir.y, dir.x);

  vec2 rel = p - a;
  float along = clamp(dot(rel, dir), 0.0, len);
  float across = dot(rel, nrm);

  // Displacement grows toward the middle of the span and vanishes at the ends,
  // so bolts stay anchored to their endpoints while thrashing in between.
  float taper = sin(along / len * PI);
  float wobble = (fbm(vec2(along * 3.5, seed * 20.0 + t * 2.2), 4, 2.2, 0.55) - 0.5) * 2.0;
  wobble += (fbm(vec2(along * 11.0, seed * 7.0 - t * 3.5), 3, 2.0, 0.5) - 0.5) * 0.8;

  return abs(across - wobble * jag * taper);
}

void main() {
  vec2 uv = centered(vUv, uAspect);

  vec3 col = palClamp(0.03) * (1.0 - 0.5 * length(uv));

  int count = int(clamp(p_bolts, 1.0, 12.0));
  for (int i = 0; i < 12; i++) {
    if (i >= count) break;
    float fi = float(i);

    // Bolts re-roll on a fast quantised clock, so each strike is a new shape.
    float epoch = floor(uTime * 7.0 + fi * 3.1);
    float seed = hash11(epoch + fi * 51.7);

    // Live only some of the time; onset raises the odds.
    float live = step(1.0 - clamp(p_strike, 0.0, 1.0), hash11(epoch * 1.7 + fi));
    if (live < 0.5) continue;

    // Endpoints scattered around the frame.
    vec2 a = (hash22(vec2(seed, fi)) - 0.5) * vec2(2.6 * uAspect, 2.2);
    vec2 b = (hash22(vec2(seed + 3.3, fi + 1.7)) - 0.5) * vec2(2.6 * uAspect, 2.2);

    float d = boltDistance(uv, a, b, p_jag, seed, uTime);

    // Inverse falloff: hot core, broad halo. The halo has to be wide enough to
    // read at a glance - a 0.055 radius squared is a hairline at 1080p.
    float core = 0.006 / (d + 0.006);
    float halo = 0.13 / (d + 0.13);

    // Each strike decays across its epoch rather than sitting constant, but not
    // so fast that most frames catch it already faded to nothing.
    float age = fract(uTime * 7.0 + fi * 3.1);
    float decay = 0.35 + 0.65 * exp(-age * 2.2);

    vec3 tint = pal(fract(seed * 0.4 + 0.55));
    col += tint * halo * halo * p_glow * decay * 1.6;
    col += vec3(1.0) * pow(core, 1.4) * decay * 1.3;

    // Forks: a shorter branch off the middle of the bolt.
    vec2 mid = mix(a, b, 0.35 + 0.3 * seed);
    vec2 tip = mid + (hash22(vec2(seed * 5.1, fi)) - 0.5) * 1.2;
    float df = boltDistance(uv, mid, tip, p_jag * 0.7, seed + 9.0, uTime);
    float fhalo = 0.07 / (df + 0.07);
    col += tint * fhalo * fhalo * decay * 0.9;
    col += vec3(0.9) * (0.004 / (df + 0.004)) * decay * 0.9;
  }

  fragColor = vec4(col, 1.0);
}
