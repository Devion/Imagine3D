#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorld;
in float vDepth;

out vec4 fragColor;

uniform vec3  uEye;
uniform vec3  uPal0, uPal1, uPal2, uPal3, uPal4;
uniform float uBeatPulse;
uniform float uEnergy;
uniform float uTime;
uniform float uRim;
uniform float uWire;
uniform float uFogNear;
uniform float uFogFar;

vec3 palClamp(float t) {
  t = clamp(t, 0.0, 0.9999);
  float f = t * 4.0;
  int i = int(floor(f));
  float k = smoothstep(0.0, 1.0, fract(f));
  if (i == 0) return mix(uPal0, uPal1, k);
  if (i == 1) return mix(uPal1, uPal2, k);
  if (i == 2) return mix(uPal2, uPal3, k);
  return mix(uPal3, uPal4, k);
}

void main() {
  vec3 n = normalize(vNormal);

  // Library models come from a dozen authoring pipelines and their face winding
  // is not consistent. Culling back faces on such a model shows its interior, so
  // nothing is culled and the normal is flipped for rear-facing triangles instead
  // - that makes both sides light correctly rather than going black.
  if (!gl_FrontFacing) n = -n;

  vec3 viewDir = normalize(uEye - vWorld);

  // Two-light setup: a warm key and a cool fill from the opposite side, which is
  // enough to read form on an untextured model.
  vec3 keyDir = normalize(vec3(0.6, 0.8, 0.45));
  vec3 fillDir = normalize(vec3(-0.7, 0.2, -0.5));

  float key = max(0.0, dot(n, keyDir));
  float fill = max(0.0, dot(n, fillDir));

  // Rim light picks the silhouette out of the background - the single most
  // important cue when the model has no texture.
  float rim = pow(1.0 - max(0.0, dot(n, viewDir)), 3.0);

  vec3 base = palClamp(0.35 + 0.25 * n.y);

  vec3 col = base * (0.12 + 0.85 * key);
  col += palClamp(0.2) * fill * 0.35;
  col += palClamp(0.9) * rim * uRim * (0.6 + 0.6 * uBeatPulse);

  // Specular from the key light.
  vec3 h = normalize(keyDir + viewDir);
  col += vec3(1.0) * pow(max(0.0, dot(n, h)), 48.0) * 0.5;

  if (uWire > 0.5) {
    // Facet-edge glow: cheap stand-in for wireframe without an edge buffer.
    float facing = abs(dot(n, viewDir));
    col = palClamp(0.85) * pow(1.0 - facing, 2.0) * 2.0;
    col += base * 0.08;
  }

  // Depth fog into the palette's dark end so the model sits in a space.
  float fog = smoothstep(uFogNear, uFogFar, vDepth);
  col = mix(col, palClamp(0.03), fog);

  fragColor = vec4(col, 1.0);
}
