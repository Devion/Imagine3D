#include "common.glsl"
#include "palette.glsl"

// An eroded tunnel with an oil-slick sheen.
//
// The base shape is just a cylinder whose axis wanders on two sines. What makes
// it interesting is the erosion loop: octaves at a *= a (2, 4, 8 ... 256) each
// subtract abs(dot(sin(q), 1)) with an alternating, decaying sign, so successive
// octaves cut and fill in turn and the wall ends up honeycombed rather than
// merely bumpy.
//
// The iridescence is not a colour term. The accumulated glow is passed through
// 1/tanh(o^2) scaled per channel, and because that curve saturates at a different
// rate in each channel the hue shifts with intensity on its own. Trying to get
// the same look by tinting gives you a gradient, not a sheen.
//
// Technique reference: the reciprocal-tonemap glow Shadertoys.

void main() {
  vec2 uv = centered(vUv, uAspect) * 0.5;
  float t = uTime * p_speed;

  vec4 o = vec4(0.0);
  vec3 P = vec3(0.0), Q = vec3(0.0);
  float g = 0.0, d = 1.0;

  int steps = int(clamp(p_steps, 30.0, 110.0));
  float taken = 1.0;   // iterations actually run, before the ray converged

  for (int i = 0; i < 110; i++) {
    if (i >= steps || d <= 1e-4) break;
    taken += 1.0;

    // Banding by depth. The glow is written *before* the step, so the first
    // sample contributes at the near plane rather than a step in.
    o += (1.0 + sin(2.0 * length(P.xy * 3.0) + g * 2.1 + vec4(2.0, 1.0, 0.0, 0.0))) / 190.0;

    g += d * 0.5;
    P = vec3(uv * 2.0 * g, g);
    P.z += t * 2.0;

    // Cylinder about a wandering axis.
    d = 1.1 - length(P.xy - vec2(sin(P.z * 0.3), cos(P.z * 0.3)) * p_sway);

    float s = 1.0;
    for (float a = 2.0; a < 3e2; a += a) {
      Q = P * a;
      Q.xz = rot(a) * Q.xz;
      d -= s * abs(dot(sin(Q - t), vec3(1.0))) / (a * 3.0) * p_erode;
      s *= -0.7;    // alternating sign: octaves cut and fill in turn
    }
  }

  // The inverse of the iteration count, not a constant: a ray that converged
  // quickly ran few iterations and gets a large term, a ray that never found a
  // wall gets a small one. Dropping this in favour of a fixed value is what
  // flattens the whole frame to one colour.
  o += 19.0 / taken;

  // Reciprocal tone curve. Because tanh saturates at a different rate once each
  // channel is scaled differently, the hue shifts with intensity on its own -
  // that is the sheen, and no colour term produces it. The radial factor is in
  // pixel units, as the reference had it; in uv units it is a different curve.
  vec2 F = gl_FragCoord.xy;
  o = 0.01 / tanh(max(o * o, 1e-4)) / vec4(3.0, 2.0, 1.0, 1.0) * 7.0
    * pow(max(dot(F, F), 1.0), 0.14);

  // Reinhard rather than a hard clamp. The reciprocal runs away where the ray
  // barely accumulated anything, and clipping that leaves flat white plates with
  // hard edges; rolling it off keeps the sheen in the highlights.
  vec3 col = o.rgb * p_bright * 1.1;
  col = col / (1.0 + col);

  // Keep the sheen but move it into the run's colour world: luminance picks the
  // palette stop, and the raw hue is mixed back over the top.
  col = mix(palClamp(sat(luma(col) * 0.9)) * (0.6 + 1.4 * sat(luma(col))), col, 0.45);

  col *= 0.92 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
