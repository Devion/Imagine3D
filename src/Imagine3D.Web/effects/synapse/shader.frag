#include "common.glsl"
#include "palette.glsl"

// A grid of wandering nodes, each wired to the eight cells around it, stacked in
// depth layers that scale up and fade as they pass the camera.
//
// Two changes from the source. The camera offset was the mouse; it is a slow
// orbit here so the parallax still reads without an input device. And the node
// flare was driven by one bin of Shadertoy's FFT texture - that is exactly what
// uBass carries, so the effect keeps its audio reactivity natively rather than
// losing it to a constant.

#define S(a, b, t) smoothstep(a, b, t)

float n21(vec2 p) {
  vec3 a = fract(vec3(p.xyx) * vec3(213.897, 653.453, 253.098));
  a += dot(a, a.yzx + 79.76);
  return fract((a.x + a.y) * a.z);
}

// Each node sits at its cell offset plus a small lissajous wander, seeded so no
// two cells move alike.
vec2 nodePos(vec2 id, vec2 offs, float t) {
  float n = n21(id + offs);
  float n1 = fract(n * 10.0);
  float n2 = fract(n * 100.0);
  float a = t + n;
  return offs + vec2(sin(a * n1), cos(a * n2)) * 0.4;
}

float segmentDist(vec2 a, vec2 b, vec2 p) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float wire(vec2 a, vec2 b, vec2 uv) {
  float d = segmentDist(a, b, uv);
  float len = length(a - b);

  // Long connections fade out, so the mesh thins rather than turning into a
  // solid web when neighbours drift apart.
  float fade = S(1.5, 0.5, len);
  fade += S(0.05, 0.02, abs(len - 0.75));

  return S(0.04, 0.01, d) * fade;
}

float netLayer(vec2 st, float n, float t, float sparkle) {
  vec2 id = floor(st) + n;
  st = fract(st) - 0.5;

  vec2 p[9];
  int k = 0;
  for (float y = -1.0; y <= 1.0; y++)
    for (float x = -1.0; x <= 1.0; x++)
      p[k++] = nodePos(id, vec2(x, y), t);

  float m = 0.0;
  float flare = 0.0;

  for (int i = 0; i < 9; i++) {
    m += wire(p[4], p[i], st);

    float d = length(st - p[i]);
    float s = (0.005 / (d * d)) * S(1.0, 0.7, d);

    // Raised to a high power so each node is dark most of the time and briefly
    // very bright - a blink, not a pulse.
    float blink = sin((fract(p[i].x) + fract(p[i].y) + t) * 5.0) * 0.4 + 0.6;
    flare += s * pow(blink, 20.0);
  }

  // The diagonal ring, so the cell reads as a lattice and not just a star.
  m += wire(p[1], p[3], st);
  m += wire(p[1], p[5], st);
  m += wire(p[7], p[5], st);
  m += wire(p[7], p[3], st);

  float phase = (sin(t + n) + sin(t * 0.1)) * 0.25 + 0.5;
  phase += pow(sin(t * 0.1) * 0.5 + 0.5, 50.0) * 5.0;

  return m + flare * phase * sparkle;
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);

  float t = uTime * p_speed;

  float c = cos(t), s = sin(t);
  mat2 spin = mat2(c, -s, s, c);
  vec2 st = uv * spin;

  // Stands in for the mouse: a slow orbit, so the layers still separate in depth.
  vec2 cam = vec2(sin(uTime * 0.07), cos(uTime * 0.053)) * p_drift;
  cam *= spin * 2.0;

  int layers = int(clamp(p_layers, 1.0, 6.0));
  float spacing = 1.0 / float(layers);

  float m = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= layers) break;
    float fi = float(i) * spacing;

    // Depth cycles 0..1; size shrinks as z grows so the layer flies at the
    // camera, and fade hides it being born and dying.
    float z = fract(t + fi);
    float size = mix(15.0, 1.0, z);
    float fade = S(0.0, 0.6, z) * S(1.0, 0.8, z);

    m += fade * netLayer(st * size - cam * z, fi, uTime, p_sparkle);
  }

  // The source read one low FFT bin here. uBass is that same measurement, so the
  // wash behind the network still breathes with the track.
  float glow = -uv.y * p_glow;

  vec3 baseCol = pal(0.15 + sin(t * 0.4) * 0.2 + uTime * 0.01);
  vec3 col = baseCol * m + baseCol * glow;

  col *= 1.0 - dot(uv, uv);

  fragColor = vec4(max(col, 0.0), 1.0);
}
