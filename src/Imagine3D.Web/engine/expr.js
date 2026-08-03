// Tiny expression compiler.
//
// Effect parameters are written as expressions over the modulation sources -
// "1.0 + 0.3*beatPulse", "mix(0.2, 1.0, bass)" - so an effect becomes music-reactive
// without containing any sync code at all. Expressions are compiled once at load
// and evaluated per frame against a plain object of named values.

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sqrt: Math.sqrt, exp: Math.exp, sign: Math.sign,
  log: (x) => Math.log(Math.max(1e-9, x)),
  min: Math.min, max: Math.max,
  pow: Math.pow,
  atan2: Math.atan2,
  fract: (x) => x - Math.floor(x),
  mod: (x, y) => x - y * Math.floor(x / y),
  clamp: (x, a, b) => Math.min(Math.max(x, a), b),
  mix: (a, b, t) => a + (b - a) * t,
  step: (edge, x) => (x < edge ? 0 : 1),
  smoothstep: (a, b, x) => {
    const t = Math.min(Math.max((x - a) / (b - a || 1e-9), 0), 1);
    return t * t * (3 - 2 * t);
  },
  // Deterministic hash-noise: same input always gives the same output, so it can
  // be used in an expression without breaking reproducibility.
  noise: (x) => {
    const s = Math.sin(x * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  },
};

const CONSTS = { pi: Math.PI, tau: Math.PI * 2, e: Math.E, true: 1, false: 0 };

function tokenize(src) {
  const tokens = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_.]*|\d*\.?\d+(?:[eE][-+]?\d+)?|<=|>=|==|!=|&&|\|\||[-+*/%(),<>?:!])/g;
  let m, last = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last && src.slice(last, m.index).trim()) break;
    tokens.push(m[1]);
    last = re.lastIndex;
  }
  if (src.slice(last).trim()) throw new Error(`unexpected "${src.slice(last).trim()}" in "${src}"`);
  return tokens;
}

// Recursive descent with the usual precedence ladder. Returns a closure (vars) => number.
function parse(tokens, src) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    if (tokens[pos] !== t) throw new Error(`expected "${t}" but got "${tokens[pos] ?? 'end'}" in "${src}"`);
    pos++;
  };

  function ternary() {
    const cond = or();
    if (peek() !== '?') return cond;
    eat('?');
    const a = ternary();
    eat(':');
    const b = ternary();
    return (v) => (cond(v) ? a(v) : b(v));
  }
  function or() {
    let l = and();
    while (peek() === '||') { pos++; const r = and(); const p = l; l = (v) => (p(v) || r(v) ? 1 : 0); }
    return l;
  }
  function and() {
    let l = compare();
    while (peek() === '&&') { pos++; const r = compare(); const p = l; l = (v) => (p(v) && r(v) ? 1 : 0); }
    return l;
  }
  function compare() {
    let l = additive();
    while (['<', '>', '<=', '>=', '==', '!='].includes(peek())) {
      const op = tokens[pos++];
      const r = additive(), p = l;
      l = (v) => {
        const a = p(v), b = r(v);
        switch (op) {
          case '<': return a < b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '==': return a === b ? 1 : 0;
          default: return a !== b ? 1 : 0;
        }
      };
    }
    return l;
  }
  function additive() {
    let l = multiplicative();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++];
      const r = multiplicative(), p = l;
      l = op === '+' ? (v) => p(v) + r(v) : (v) => p(v) - r(v);
    }
    return l;
  }
  function multiplicative() {
    let l = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = tokens[pos++];
      const r = unary(), p = l;
      l = op === '*' ? (v) => p(v) * r(v)
        : op === '/' ? (v) => { const d = r(v); return d === 0 ? 0 : p(v) / d; }
        : (v) => { const d = r(v); return d === 0 ? 0 : p(v) % d; };
    }
    return l;
  }
  function unary() {
    if (peek() === '-') { pos++; const e = unary(); return (v) => -e(v); }
    if (peek() === '+') { pos++; return unary(); }
    if (peek() === '!') { pos++; const e = unary(); return (v) => (e(v) ? 0 : 1); }
    return primary();
  }
  function primary() {
    const t = tokens[pos];
    if (t === undefined) throw new Error(`unexpected end of "${src}"`);

    if (t === '(') { pos++; const e = ternary(); eat(')'); return e; }

    if (/^\d|^\./.test(t)) { pos++; const n = parseFloat(t); return () => n; }

    if (/^[A-Za-z_]/.test(t)) {
      pos++;
      if (peek() === '(') {
        pos++;
        const args = [];
        if (peek() !== ')') {
          args.push(ternary());
          while (peek() === ',') { pos++; args.push(ternary()); }
        }
        eat(')');
        const fn = FUNCS[t];
        if (!fn) throw new Error(`unknown function "${t}" in "${src}"`);
        return (v) => fn(...args.map((a) => a(v)));
      }
      if (t in CONSTS) { const c = CONSTS[t]; return () => c; }
      // Identifier: resolved from the modulation object each frame. Supports
      // dotted names like bands.bass.
      const path = t.split('.');
      return (v) => {
        let cur = v;
        for (const k of path) {
          if (cur == null) return 0;
          cur = cur[k];
        }
        return typeof cur === 'number' && Number.isFinite(cur) ? cur : 0;
      };
    }

    throw new Error(`unexpected "${t}" in "${src}"`);
  }

  const fn = ternary();
  if (pos < tokens.length) throw new Error(`trailing "${tokens[pos]}" in "${src}"`);
  return fn;
}

const cache = new Map();

/** Compile an expression (or a bare number) into (vars) => number. */
export function compileExpr(src) {
  if (typeof src === 'number') return () => src;
  if (src == null || src === '') return () => 0;

  const key = String(src);
  if (cache.has(key)) return cache.get(key);

  let fn;
  try {
    fn = parse(tokenize(key), key);
  } catch (err) {
    // A bad expression must not take the whole render down - fall back to a
    // constant and make the problem visible in the console.
    console.warn(`[expr] ${err.message} - using 0`);
    fn = () => 0;
  }
  cache.set(key, fn);
  return fn;
}

/** Compile a {name: expression} map into {name: (vars) => number}. */
export function compileParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params ?? {})) out[k] = compileExpr(v);
  return out;
}

/** Evaluate a compiled param map against the current modulation values. */
export function evalParams(compiled, vars, into = {}) {
  for (const k in compiled) into[k] = compiled[k](vars);
  return into;
}
