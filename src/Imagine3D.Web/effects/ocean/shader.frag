#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Open sea as a raymarched heightfield.
//
// The surface is a sum of octaves, each a directional wave whose profile is
// sharpened toward a cusp - that sharpening is what gives sea its crests instead
// of the rounded blobs plain noise produces. Intersection is found by walking
// forward and then bisecting, which is far cheaper than sphere-tracing a field
// that has no valid distance bound.

float waveOctave(vec2 uv, float choppy) {
  uv += gradNoise(uv);
  vec2 wv = 1.0 - abs(sin(uv));
  vec2 swv = abs(cos(uv));
  wv = mix(wv, swv, wv);
  // Cusped profile: 1 - (wv.x*wv.y)^0.65 leans the wave into a crest.
  return pow(1.0 - pow(wv.x * wv.y, 0.65), choppy);
}

float seaHeight(vec2 p, float t, int octaves, float baseHeight, float choppy) {
  float freq = 0.16;
  float amp = baseHeight;
  float ch = choppy;
  float h = 0.0;

  // Each octave is rotated so the swells cross rather than lining up.
  mat2 rotm = mat2(1.6, 1.2, -1.2, 1.6);
  vec2 uv = p;
  uv.x *= 0.75;

  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float d = waveOctave((uv + t) * freq, ch);
    d += waveOctave((uv - t) * freq, ch);
    h += d * amp;
    uv = rotm * uv;
    freq *= 1.9;
    amp *= 0.22;
    ch = mix(ch, 1.0, 0.2);
  }
  return h;
}

vec3 skyColour(vec3 rd) {
  float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(palClamp(0.55), palClamp(0.12), pow(up, 0.7));

  // Low sun for the water to catch.
  vec3 sunDir = normalize(vec3(0.35, 0.12, 0.9));
  float sun = pow(max(0.0, dot(rd, sunDir)), 380.0);
  float haze = pow(max(0.0, dot(rd, sunDir)), 8.0);
  sky += palClamp(0.97) * sun * 2.2;
  sky += palClamp(0.85) * haze * 0.22;
  return sky;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;
  int octaves = int(clamp(p_octaves, 2.0, 8.0));

  vec3 ro = vec3(0.0, p_eye, t * 3.0);
  vec3 rd = normalize(vec3(uv, 1.5));
  rd.yz = rot(-0.12) * rd.yz;                       // look slightly down
  rd.xz = rot(sin(uTime * 0.05) * 0.2) * rd.xz;     // slow heading drift

  vec3 col;

  if (rd.y >= -0.005) {
    col = skyColour(rd);
  } else {
    // March forward until below the surface, then bisect for the crossing.
    float near = 0.0, far = 220.0;
    vec3 p = ro + rd * far;
    float hFar = p.y - seaHeight(p.xz, t, octaves, p_height, p_choppy);

    if (hFar > 0.0) {
      col = skyColour(rd);
    } else {
      vec3 pNear = ro;
      float hNear = pNear.y - seaHeight(pNear.xz, t, octaves, p_height, p_choppy);

      for (int i = 0; i < 8; i++) {
        float mid = mix(near, far, hNear / max(1e-5, hNear - hFar));
        vec3 pm = ro + rd * mid;
        float hm = pm.y - seaHeight(pm.xz, t, octaves, p_height, p_choppy);
        if (hm < 0.0) { far = mid; hFar = hm; } else { near = mid; hNear = hm; }
      }

      float dist = mix(near, far, hNear / max(1e-5, hNear - hFar));
      vec3 pos = ro + rd * dist;

      // Normal by finite differences, scaled with distance so far water does not
      // alias into noise.
      float e = max(0.02, dist * 0.008);
      vec3 n = normalize(vec3(
        seaHeight(pos.xz - vec2(e, 0.0), t, octaves, p_height, p_choppy)
          - seaHeight(pos.xz + vec2(e, 0.0), t, octaves, p_height, p_choppy),
        2.0 * e,
        seaHeight(pos.xz - vec2(0.0, e), t, octaves, p_height, p_choppy)
          - seaHeight(pos.xz + vec2(0.0, e), t, octaves, p_height, p_choppy)));

      vec3 refl = reflect(rd, n);
      float fres = pow(1.0 - max(0.0, dot(n, -rd)), 4.0) * 0.92 + 0.08;

      vec3 deep = palClamp(0.10);
      vec3 shallow = palClamp(0.42);

      // Subsurface: crests glow because light passes through thin water.
      float lift = max(0.0, pos.y - seaHeight(pos.xz, t, octaves, p_height, p_choppy) * 0.0);
      float crest = clamp((pos.y + p_height) / max(0.1, p_height * 2.0), 0.0, 1.0);
      vec3 sss = shallow * pow(crest, 3.0) * 0.6;

      col = mix(deep + sss, skyColour(refl), fres);

      // Specular glitter.
      vec3 sunDir = normalize(vec3(0.35, 0.12, 0.9));
      col += palClamp(0.98) * pow(max(0.0, dot(refl, sunDir)), 90.0) * 1.4;

      // Foam on the sharpest crests.
      float foam = smoothstep(0.72, 1.0, crest) * smoothstep(0.55, 0.95, n.y);
      col = mix(col, palClamp(0.9), foam * 0.28);

      // Aerial haze into the horizon.
      col = mix(col, skyColour(rd), smoothstep(30.0, 190.0, dist));
    }
  }

  col *= 0.92 + 0.25 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
