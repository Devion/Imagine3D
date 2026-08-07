// Effect discovery and instantiation.
//
// An effect is one folder under effects/<id>/ containing effect.json. If the
// manifest names a `shader`, that fragment shader is all it needs - no JavaScript.
// If it sets `"module": true`, effects/<id>/effect.js is imported and must default-
// export a class with render(). Nothing in this file needs editing to add either.

import { UNIFORM_PREAMBLE, VERTEX_SHADER, createProgram, resolveIncludes, bindTexture } from './gl.js';
import { compileParams, evalParams } from './expr.js';

/** Effect param -> GLSL uniform name. Kept trivial so shader authors can guess it. */
const uniformName = (key) => `p_${key}`;

/** A fragment-shader effect: the common case, needing no JS at all. */
export class FragmentEffect {
  constructor(gl, manifest, program) {
    this.gl = gl;
    this.manifest = manifest;
    this.program = program.program;
    this.uniforms = program.uniforms;
    this.kind = manifest.kind;
    this.id = manifest.id;
  }

  static async create(gl, manifest) {
    const file = manifest.shader || 'shader.frag';
    // `rev` busts the browser cache when the shader is edited.
    const res = await fetch(`effects/${manifest.id}/${file}?v=${manifest.rev ?? 0}`);
    if (!res.ok) throw new Error(`effect "${manifest.id}": missing ${file}`);

    const body = await resolveIncludes(await res.text());

    // Declare a uniform per manifest param so a shader author writes p_speed and
    // it is simply there, wired to the storyboard's expression.
    const paramDecls = Object.entries(manifest.params ?? {})
      .map(([k, spec]) => {
        const type = spec.type === 'bool' || spec.type === 'int' ? 'float' : spec.type;
        const glslType = type === 'color' ? 'vec3' : 'float';
        return `uniform ${glslType} ${uniformName(k)};`;
      })
      .join('\n');

    const source = `${UNIFORM_PREAMBLE}\n${paramDecls}\n#line 1\n${body}`;
    const program = createProgram(gl, VERTEX_SHADER, source, `effect "${manifest.id}"`);
    return new FragmentEffect(gl, manifest, program);
  }

  /**
   * Draw into whatever framebuffer is currently bound.
   * `state` carries resolution/time/music uniforms; `params` is the already
   * evaluated parameter map; `textures` supplies prev/feedback/video/image.
   */
  render(state, params, textures, quad) {
    const gl = this.gl;
    const u = this.uniforms;
    gl.useProgram(this.program);

    if (u.uResolution) gl.uniform2f(u.uResolution, state.width, state.height);
    if (u.uAspect) gl.uniform1f(u.uAspect, state.width / state.height);
    if (u.uAmount) gl.uniform1f(u.uAmount, state.amount ?? 1);

    const m = state.mod;
    const set = (name, value) => { if (u[name]) gl.uniform1f(u[name], value ?? 0); };
    set('uTime', m.t);
    set('uSceneT', m.sceneT);
    set('uSectionT', m.sectionT);
    set('uBeat', m.beat);
    set('uBeatPulse', m.beatPulse);
    set('uBeatStrength', m.beatStrength);
    set('uBar', m.bar);
    set('uBarPulse', m.barPulse);
    set('uPhrase', m.phrase);
    set('uOnset', m.onset);
    set('uRms', m.rms);
    set('uEnergy', m.energy);
    set('uSub', m.sub);
    set('uBass', m.bass);
    set('uLowMid', m.lowMid);
    set('uMid', m.mid);
    set('uHigh', m.high);
    set('uAir', m.air);
    set('uRmsPeak', m.rmsPeak);
    set('uSubPeak', m.subPeak);
    set('uBassPeak', m.bassPeak);
    set('uLowMidPeak', m.lowMidPeak);
    set('uMidPeak', m.midPeak);
    set('uHighPeak', m.highPeak);
    set('uAirPeak', m.airPeak);

    const pal = state.palette;
    for (let i = 0; i < 5; i++) {
      const loc = u[`uPal${i}`];
      if (loc) gl.uniform3f(loc, pal[i][0], pal[i][1], pal[i][2]);
    }

    for (const [key, value] of Object.entries(params)) {
      const loc = u[uniformName(key)];
      if (loc) gl.uniform1f(loc, value);
    }

    if (u.uSeed) gl.uniform1f(u.uSeed, state.seed ?? 0);
    if (u.uBlendMode) gl.uniform1i(u.uBlendMode, state.blendMode ?? 0);

    bindTexture(gl, u.uPrev, textures.prev, 0);
    bindTexture(gl, u.uFeedback, textures.feedback, 1);
    bindTexture(gl, u.uVideo, textures.video, 2);
    bindTexture(gl, u.uNext, textures.next, 3);
    bindTexture(gl, u.uText, textures.text, 4);
    bindTexture(gl, u.uImage, textures.image ?? null, 5);
    if (u.uVideoAmount) gl.uniform1f(u.uVideoAmount, textures.videoAmount ?? 0);
    // 1 rather than 0: a stretch by a zero aspect is a divide by zero, and an
    // effect asking for the ratio when nothing is bound should get a square.
    if (u.uImageAspect) gl.uniform1f(u.uImageAspect, textures.imageAspect || 1);
    if (u.uHasImage) gl.uniform1f(u.uHasImage, textures.hasImage ?? 0);

    quad.draw();
  }

  dispose() { this.gl.deleteProgram(this.program); }
}

/** Loaded manifest + a lazily built instance and its compiled parameter map. */
export class EffectRegistry {
  constructor() {
    this.manifests = new Map();
    this.instances = new Map();
    this.failed = new Map();
  }

  static async load() {
    const reg = new EffectRegistry();
    const res = await fetch('api/effects');
    if (!res.ok) throw new Error(`could not load the effect registry (${res.status})`);
    for (const m of await res.json()) reg.manifests.set(m.id, m);
    return reg;
  }

  get(id) { return this.manifests.get(id); }
  get size() { return this.manifests.size; }

  ids(kind) {
    return [...this.manifests.values()]
      .filter((m) => !kind || m.kind === kind)
      .map((m) => m.id);
  }

  /** Instantiate (and cache) an effect. Throws with the effect id in the message. */
  async instance(gl, id, ctx) {
    if (this.instances.has(id)) return this.instances.get(id);
    if (this.failed.has(id)) throw this.failed.get(id);

    const manifest = this.manifests.get(id);
    if (!manifest) throw new Error(`unknown effect "${id}"`);

    try {
      let inst;
      if (manifest.module) {
        // Same cache-busting as the shader path: ES modules are cached by URL, so
        // an edited effect.js would otherwise keep running its previous version.
        const mod = await import(`../effects/${id}/effect.js?v=${manifest.rev ?? 0}`);
        const Ctor = mod.default;
        if (typeof Ctor !== 'function')
          throw new Error(`effects/${id}/effect.js must default-export a class`);
        inst = new Ctor(gl, manifest, ctx);
        if (inst.init) await inst.init(ctx);
      } else {
        inst = await FragmentEffect.create(gl, manifest);
      }
      inst.compiledParams = compileParams(defaultParams(manifest));
      this.instances.set(id, inst);
      return inst;
    } catch (err) {
      // Remember the failure so a broken effect is reported once, not every frame.
      const wrapped = new Error(`effect "${id}": ${err.message}`);
      this.failed.set(id, wrapped);
      throw wrapped;
    }
  }

  dispose() {
    for (const inst of this.instances.values()) inst.dispose?.();
    this.instances.clear();
    this.failed.clear();
  }
}

export function defaultParams(manifest) {
  const out = {};
  for (const [k, spec] of Object.entries(manifest.params ?? {})) out[k] = spec.default;
  return out;
}

/**
 * Merge a storyboard scene's parameter overrides over the manifest defaults and
 * compile the result. Overrides are expressions, same as defaults.
 */
export function compileSceneParams(manifest, overrides) {
  return compileParams({ ...defaultParams(manifest), ...(overrides ?? {}) });
}

export { evalParams };
