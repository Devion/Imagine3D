#include "common.glsl"
#include "palette.glsl"

// "Trailing the Twinkling Tunnelwisp" (CC0, mrange), unpacked.
//
// The source is written as one comma-chained for-loop with everything in the
// increment clause and relies on uninitialised locals reading as zero. That is
// undefined behaviour rather than a guarantee, and ANGLE is entitled to hand back
// garbage, so every accumulator is explicitly zeroed here and the loop body is
// written out. The maths is unchanged.
//
// The surface is the difference between the same gyroid sampled at two
// frequencies, which gives a shell with structure on it rather than a smooth
// tube. The waterline is free: mirroring y about the horizon before evaluating
// the field means the lower half marches the same geometry upside down, and
// cubing the distance down there dims it into a reflection.

// Gyroid distance, adapted by the author from Paul Karlik's "Gyroid Travel".
float gyroid(vec4 p, float s) {
  return abs(dot(sin(p *= s), cos(p.zxwy)) - 1.0) / s;
}

void main() {
  float T = uTime;

  // The ray, resolution-independent: the source built this from fragCoord and
  // then normalised, so the pixel scale cancels out anyway.
  vec3 dir = normalize(vec3((vUv - 0.5) * vec2(uAspect, 1.0), 1.0));

  vec4 U = vec4(2.0, 1.0, 0.0, 3.0);

  float d = 0.0, z = 0.0, s = 0.0;
  vec4 o = vec4(0.0), q = vec4(0.0), p = vec4(0.0);

  for (int i = 0; i < 78; i++) {
    // Step first, so the accumulation below sees the sample this iteration set
    // up - the source got this ordering from its comma-expression increment.
    z += d + 5e-4;

    q = vec4(dir * z, 0.2);
    q.z += T * p_speed / 30.0;

    // Sign before mirroring: above the waterline it is a wall, below it is the
    // reflection of one.
    s = q.y + 0.1;
    q.y = abs(s);

    p = q;
    p.y -= 0.11;

    // mat2(cos(a + vec4(0,11,33,0))) is a rotation by a, using 22/7 ~ PI so that
    // cos(a+3.5PI) = sin(a) and cos(a+10.5PI) = -sin(a). Written out because a
    // mat2 built from a single vec4 is a constructor form worth not relying on.
    vec4 r = cos(vec4(0.0, 11.0, 33.0, 0.0) - p_twist * p.z);
    p.xy *= mat2(r.x, r.y, r.z, r.w);

    p.y -= 0.2;

    d = abs(gyroid(p, 8.0) - gyroid(p, p_detail)) / 4.0;

    // Glow colour cycles with depth, so the cave changes hue as it recedes.
    p = 1.0 + cos(0.7 * U + 5.0 * q.z);

    // Above the waterline the falloff is 1/d and bright; below it is 1/d^3 and
    // dimmed to a tenth, which is the whole reflection.
    o += (s > 0.0 ? 1.0 : 0.1) * p.w * p / max(s > 0.0 ? d : d * d * d, 5e-4);
  }

  // The wisp: a triple-sine beat running down the tunnel axis.
  float pulse = p_wisp + sin(T) * sin(1.7 * T) * sin(2.3 * T);
  o += pulse * 1e3 * U / max(length(q.xy), 1e-4);

  vec3 col = tanh(o / 1e5).rgb;

  // The source's colour comes out of U and the depth cosine. Blending toward the
  // palette keeps that structure but lets the video's colour world win.
  col = mix(col, palClamp(luma(col)) * (0.4 + luma(col)), p_tint);

  fragColor = vec4(col, 1.0);
}
