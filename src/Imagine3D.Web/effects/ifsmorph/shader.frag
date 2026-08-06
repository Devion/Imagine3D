#include "common.glsl"
#include "palette.glsl"

// A kaleidoscopic-IFS solid, lit properly.
//
// The fold is the standard one: mirror into the positive octant, sort the
// components so the largest is x, scale about an offset, repeat. Dividing the
// final sphere distance by the accumulated scale is what keeps it a valid
// distance estimate after all that magnification.
//
// What makes this one different from the other fractals in this library is that
// it is a *surface*. Everything else here accumulates glow along the ray and
// never computes a normal; this one does, which buys diffuse, specular and
// Fresnel, and those are what read as a solid object rather than a light field.
//
// The face texture is a curl-style loop - a point advected by a field built from
// its own accumulated offset - which gives flowing filaments that stay put on
// the surface rather than swimming with the camera.
//
// Technique reference: the kaleidoscopic-IFS family of Shadertoys.

vec3 gOff;
float gScl;

float ifsDist(vec3 p) {
  float s = 1.0;
  // Five folds, not six. The sixth adds structure well below a pixel at video
  // resolution, and all it buys is a stipple of missed rays on the surface.
  for (int k = 0; k < 5; k++) {
    p = abs(p);
    // Sort descending. Three compares is cheaper than any general sort and the
    // fold only needs the largest component in x.
    if (p.x < p.y) p.xy = p.yx;
    if (p.x < p.z) p.xz = p.zx;
    if (p.y < p.z) p.yz = p.zy;
    p = p * gScl - gOff * (gScl - 1.0);
    s *= gScl;
  }
  return (length(p) - 0.8) / s;
}

// Curl-ish advection. Each round rotates the coordinate and the accumulated
// offset by the same fixed matrix, so the filaments coil instead of sliding.
float faceTexture(vec2 c, float t) {
  float j = dot(c, c);
  vec2 e = vec2(0.0);
  float k = 0.7, i = 0.7;
  const mat2 l = mat2(0.540302, -0.841470, 0.841470, 0.540302);

  for (int g = 0; g < 9; g++) {
    c = l * c;
    e = l * e;
    vec2 a = c * i + e + vec2(t * 0.7, t * 0.2 + float(g) * 0.73);
    float m = sin(a.x * 1.4 + t) + cos(a.y * 3.6 - j * 4.0);
    e += vec2(cos(a.y + m - t), sin(a.x - m + t)) * 0.63;
    k += (dot(cos(a), sin(a.yx)) + 0.5) / i;
    i *= 1.19;
  }
  // 0.12 rather than the reference's 0.4: h drives three cosines below, and at
  // the higher scale they cycle several times across one pixel of a surface this
  // detailed.
  return k * 0.12;
}

void main() {
  vec2 uv = centered(vUv, uAspect) * 0.5;
  float t = uTime * p_spin;

  // Orbit radius 4.2, not the reference's 2.8: the widest fold preset puts the
  // attractor's extent near 3, so much closer than this and the camera ends up
  // inside the solid and the frame fills with its interior.
  //
  // The focal length carries the rest. At 5.5 units behind a focal length of 1.2
  // this saw about 8 units across and drew a solid 3 across in the middle of it,
  // which is a specimen on a slide. 4.2 units behind a focal length of 2.2 sees
  // about 3.4, so the solid runs out past the edges of the frame and the camera
  // is close enough for its own orbit to read as parallax over the faces.
  vec3 ro = vec3(4.6 * cos(t * 0.3), 2.1 + 0.9 * sin(t * 0.2), 4.6 * sin(t * 0.3));
  vec3 ww = normalize(-ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.85 * ww);

  // Cycle the fold parameters between four presets. The smoothstep on the
  // fractional part holds each preset for a while instead of morphing linearly
  // the whole time, so the shape reads as settling between forms.
  float cyc = uTime * p_morph;
  float cur = floor(cyc);
  float ph = smoothstep(0.15, 0.85, fract(cyc));
  int a = int(mod(cur, 4.0)), b = int(mod(cur + 1.0, 4.0));

  vec3 offs[4];
  offs[0] = vec3(1.2, 1.2, 1.2);
  offs[1] = vec3(1.5, 1.5, 1.5);
  offs[2] = vec3(1.0, 1.3, 1.0);
  offs[3] = vec3(1.4, 0.8, 1.4);
  float scls[4];
  scls[0] = 2.0; scls[1] = 2.2; scls[2] = 2.0; scls[3] = 2.4;

  gOff = mix(offs[a], offs[b], ph);
  gScl = mix(scls[a], scls[b], ph);

  mat2 m1 = rot(uTime * 0.35 * p_spin);
  mat2 m2 = rot(uTime * 0.45 * p_spin);

  int steps = int(clamp(p_steps, 40.0, 160.0));
  const float MAXT = 20.0;
  float d = 0.0, dist = 0.0, glow = 0.0;
  bool hit = false;

  for (int i = 0; i < 160; i++) {
    if (i >= steps) break;
    vec3 q = ro + dist * rd;
    q.xz = m1 * q.xz;
    q.yz = m2 * q.yz;
    d = ifsDist(q);
    // Inverse-square accumulation alongside the march, so the structure glows
    // through itself even though the ray stops at the first surface.
    glow += 0.004 / (0.01 + d * d);
    // Tolerance scaled by distance. A fixed epsilon on a fractal this detailed
    // leaves a fraction of rays exhausting the step budget without converging,
    // and shading those as if they had hit is what speckles the silhouette.
    if (d < 0.0018 * max(dist, 1.0)) { hit = true; break; }
    if (dist > MAXT) break;
    dist += d * 0.6;
  }

  // The space around it. Near-black behind a solid that only covers part of the
  // frame leaves the rest of the shot doing nothing; a lit gradient plus the
  // structure's own glow bleeding into it means the corners still carry the
  // scene when the attractor shrinks on a morph.
  vec3 col = mix(palClamp(0.20), palClamp(0.01), sat(length(uv) * 1.5)) * 0.55;
  col += palClamp(0.72) * glow * 0.045 * p_glow;

  // Stars from a product of sines: cheap, and dense enough at this exponent.
  vec3 bg = rd * 15.0;
  float stars = pow(sat(sin(bg.x * 25.0) * sin(bg.y * 25.0) * sin(bg.z * 25.0)), 45.0);
  col += vec3(0.9, 0.95, 1.0) * stars * (hit ? 0.0 : 1.0) * 1.5;

  if (hit) {
    vec3 q = ro + dist * rd;
    q.xz = m1 * q.xz;
    q.yz = m2 * q.yz;

    // Tetrahedral normal: four taps instead of six.
    vec2 e = vec2(1.0, -1.0) * 0.5773 * 0.002;
    vec3 n = e.xyy * ifsDist(q + e.xyy) + e.yyx * ifsDist(q + e.yyx)
           + e.yxy * ifsDist(q + e.yxy) + e.xxx * ifsDist(q + e.xxx);
    n = normalize(n);

    // Project onto the dominant axis for a face-local uv, so the texture sits on
    // the surface instead of being smeared across the silhouette.
    vec3 an = abs(n);
    vec2 faceUV = an.x > an.y && an.x > an.z ? q.yz
                : an.y > an.x && an.y > an.z ? q.xz : q.xy;
    vec3 fid = step(an.yzx, an) * step(an.zxy, an) * sign(n);
    float fval = dot(fid, vec3(1.1, 2.3, 3.7));

    // Scaled down from the reference's 1.5. The falloff below is a Gaussian on
    // this coordinate, so when a morph preset grows the attractor the faces move
    // out past the falloff and go black in bands. Widening it keeps the texture
    // present across every preset.
    vec2 c2 = faceUV * 0.6;
    float h = faceTexture(c2, uTime * 0.35 * p_flow);

    // The middle term's frequency is held down deliberately: at the reference's
    // rate the filaments land below a pixel at video resolution and the surface
    // aliases into white noise rather than reading as texture.
    vec3 texCol = pal(fract(fval * 0.12 + 0.05)) * (cos(h * 2.5 + 1.57) * 0.5 + 0.5)
                + pal(fract(fval * 0.12 + 0.38)) * (sin(h * 5.0) + 0.9)
                + pal(fract(fval * 0.12 + 0.71)) * (cos(h * 1.5 + 4.71) * 0.5 + 0.5);
    // The three terms sum to about 3.9 at full strength. In the reference the
    // narrow Gaussian above was doing double duty as exposure, so widening it
    // means scaling here instead - without this every face clamps to 1 and the
    // whole solid goes flat white with no texture visible at all.
    texCol *= 0.34 * exp(-dot(c2, c2) * 0.25);
    texCol = sat(texCol);

    vec3 lig = normalize(vec3(0.7, 1.0, -0.8));
    float dif = max(dot(n, lig), 0.0);
    float spe = pow(max(dot(reflect(rd, n), lig), 0.0), 48.0);
    float fre = pow(sat(1.0 + dot(n, rd)), 3.0);

    col = texCol * 2.0;
    col += texCol * dif * 0.6;
    col += vec3(1.0, 0.95, 0.9) * spe * 1.5;
    col += texCol * fre * 2.5;
    col *= sat(1.25 - length(c2) * 0.35);
  }

  col = col / (1.0 + col);            // Reinhard
  col = pow(col, vec3(0.4545));
  col *= 0.92 + 0.3 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
