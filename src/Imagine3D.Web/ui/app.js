// UI shell: project management, settings, and the visible generation chain.
// All rendering work lives in engine/; this file only orchestrates and displays.

import { CaptureClient } from '../engine/capture.js';

const $ = (id) => document.getElementById(id);

const STAGES = [
  { key: 'analyze', name: 'Analyse audio' },
  { key: 'intent', name: 'Infer intent' },
  { key: 'storyboard', name: 'Build storyboard' },
  { key: 'ltx', name: 'Generate LTX' },
  { key: 'render', name: 'Render frames' },
  { key: 'encode', name: 'Encode + mux' },
];

/// Kinds that can carry a scene. Post, transition and text effects are layers,
/// not something the first scene could be.
const SCENE_KINDS = ['scene2d', 'scene3d', 'raymarch'];

const state = {
  project: null,
  detail: null,
  analysis: null,
  storyboard: null,
  effects: [],
  running: false,
  // A manual shortened copy reports over the same channel as a generation, but
  // it is not a generation - it has no chain to light up.
  trimOnly: false,
};

// ------------------------------------------------------------------ api

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* non-JSON error body */ }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// ------------------------------------------------------------------ capture

const capture = new CaptureClient({
  onStatus(s) {
    const el = $('conn');
    el.textContent = s;
    el.className = `conn ${s === 'connected' ? 'ok' : s === 'disconnected' || s === 'error' ? 'bad' : ''}`;
  },
  onProgress(p) { onStageProgress(p); },
  onWarnings(list) { showWarnings(list); },
});
capture.connect();

// ------------------------------------------------------------------ stages

function buildStages() {
  $('stages').innerHTML = STAGES.map((s, i) => `
    <li class="stage" id="stage-${s.key}">
      <div class="num">${i + 1}</div>
      <div class="name">${s.name}</div>
      <div class="bar"><div class="fill"></div></div>
      <div class="detail"></div>
    </li>`).join('');
}

function resetStages() {
  for (const s of STAGES) {
    const el = $(`stage-${s.key}`);
    if (!el) continue;
    el.className = 'stage';
    el.querySelector('.fill').style.width = '0';
    el.querySelector('.detail').textContent = '';
  }
  $('thumb-wrap').classList.add('hidden');
  hideWarnings();
}

function onStageProgress(p) {
  if (p.stage === 'done') {
    finishRun(p);
    return;
  }

  // Keep a trim's ticks off the chain: marking "encode" active would light every
  // stage above it as done, claiming work that never ran.
  if (state.trimOnly) {
    setTrimStatus(p.detail ?? '');
    return;
  }

  const el = $(`stage-${p.stage}`);
  if (!el) return;

  const done = p.fraction >= 0.999;
  el.className = `stage ${p.failed ? 'failed' : done ? 'done' : 'active'}`;
  el.querySelector('.fill').style.width = `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`;
  el.querySelector('.detail').textContent = p.detail ?? '';

  // Mark everything above the active stage as finished, so a skipped stage does
  // not sit half-lit forever.
  const idx = STAGES.findIndex((s) => s.key === p.stage);
  for (let i = 0; i < idx; i++) {
    const prev = $(`stage-${STAGES[i].key}`);
    if (prev && !prev.classList.contains('done') && !prev.classList.contains('failed')) {
      prev.classList.add('done');
      prev.querySelector('.fill').style.width = '100%';
    }
  }

  // The plan is on disk the moment its stage finishes, and the render that follows
  // is minutes long. Showing it now rather than at the end of the run is the
  // difference between reviewing the scenes and finding out what they were.
  if (p.stage === 'storyboard' && done) loadStoryboard();

  if (p.thumbnail) {
    $('thumb').src = p.thumbnail;
    $('thumb-wrap').classList.remove('hidden');
  }
}

async function finishRun(p) {
  state.running = false;
  setRunButtons(true);
  $('btn-cancel').classList.add('hidden');

  if (state.trimOnly) {
    state.trimOnly = false;
    // refreshProject first: it rewrites the status line from what is on disk,
    // and the outcome of this run is the more useful thing to leave on screen.
    await refreshProject();
    setTrimStatus(p.detail ?? '', p.failed);
    return;
  }

  if (p.failed) {
    showWarnings([p.detail], true);
    return;
  }

  for (const s of STAGES) {
    const el = $(`stage-${s.key}`);
    if (el && !el.classList.contains('failed')) {
      el.classList.add('done');
      el.querySelector('.fill').style.width = '100%';
    }
  }

  await loadStoryboard();
  await refreshProject();
  showResult();
}

// ------------------------------------------------------------------ warnings

function showWarnings(list, isError = false) {
  const el = $('warnings');
  const items = (list ?? []).filter(Boolean);
  if (!items.length) return;
  el.className = `warnings${isError ? ' error' : ''}`;
  el.innerHTML = `<strong>${isError ? 'Failed' : 'Warnings'}</strong>
    <ul>${items.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
  el.classList.remove('hidden');
}

function hideWarnings() { $('warnings').classList.add('hidden'); }

const escapeHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ projects

async function refreshProjects() {
  const list = await api('api/projects');
  const sel = $('project-select');
  sel.innerHTML = list.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('');

  if (!list.length) {
    $('view-empty').classList.remove('hidden');
    $('view-project').classList.add('hidden');
    return;
  }

  const wanted = state.project && list.some((p) => p.name === state.project)
    ? state.project : list[0].name;
  sel.value = wanted;
  await selectProject(wanted);
}

async function selectProject(name) {
  state.project = name;
  capture.project = name;
  $('view-empty').classList.add('hidden');
  $('view-project').classList.remove('hidden');
  resetStages();
  await refreshProject();
  await loadAnalysis();
  await loadStoryboard();
  showResult();
}

async function refreshProject() {
  const d = await api(`api/projects/${encodeURIComponent(state.project)}`);
  state.detail = d;
  applySettings(d.settings);

  $('source-info').innerHTML = d.mp3
    ? `<div><strong>${escapeHtml(d.mp3)}</strong></div>
       <div class="muted">${d.txt ? `lyrics: ${escapeHtml(d.txt)}` : 'no lyrics file'}</div>`
    : '<div class="muted">No MP3 imported yet.</div>';

  $('btn-analyze').disabled = !d.mp3;
  setTrimStatus(d.trimmedOutput
    ? `Already there: ${d.trimmedOutput.split('/').pop()}`
    : '');
  setRunButtons(!state.running);
}

function setTrimStatus(text, isError = false) {
  const el = $('trim-status');
  el.textContent = text;
  el.className = `hint${isError ? ' bad' : ''}`;
}

function applySettings(s) {
  for (const b of document.querySelectorAll('#aspect button'))
    b.classList.toggle('active', b.dataset.value === s.aspect);
  $('fps').value = String(s.fps);
  $('encoder').value = s.encoder;
  $('crf').value = String(s.crf);
  $('crf-out').textContent = String(s.crf);
  $('supersample').value = String(s.supersample);
  $('seed').value = String(s.seed);
  $('random-seed').checked = s.randomSeedEachRun !== false;
  populateOpeners(s.aspect, s.openingEffect ?? '');
  $('trim-enabled').checked = !!s.saveTrimmedCopy;
  $('trim-minutes').value = String(s.trimMinutes ?? 4);
  $('trim-mb').value = String(s.trimTargetMb ?? 0);
  $('bpm-override').value = s.bpmOverride ?? '';
  $('ltx-enabled').checked = !!s.ltx?.enabled;
  $('ltx-count').value = String(s.ltx?.maxInserts ?? 6);
  $('ltx-init').value = s.ltx?.initMode ?? 'render';
  $('ltx-enhance').checked = !!s.ltx?.promptEnhance;
}

/// Effects are discovered by scanning folders, so the list is whatever is on disk
/// right now - never a hard-coded set here.
async function loadEffects() {
  try { state.effects = (await api('api/effects')) ?? []; }
  catch { state.effects = []; }   // the dropdown degrades to Auto only
}

function populateOpeners(aspect, selected) {
  const sel = $('opening-effect');
  const pool = state.effects
    .filter((e) => SCENE_KINDS.includes(e.kind))
    .filter((e) => !e.aspects?.length || e.aspects.includes(aspect))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  const opts = ['<option value="">Auto — director picks</option>'];
  for (const e of pool) {
    const band = `${e.energyRange?.[0] ?? 0}–${e.energyRange?.[1] ?? 1}`;
    opts.push(`<option value="${escapeHtml(e.id)}" title="${escapeHtml(e.description ?? '')}"
      >${escapeHtml(e.name || e.id)} — energy ${band}</option>`);
  }

  // Keep a pin that is no longer available visible rather than silently
  // resetting to Auto: the director ignores it, and the user should be able to
  // see that is what happened.
  if (selected && !pool.some((e) => e.id === selected))
    opts.push(`<option value="${escapeHtml(selected)}">${escapeHtml(selected)} — not available</option>`);

  sel.innerHTML = opts.join('');
  sel.value = selected ?? '';
}

function collectSettings() {
  const aspect = document.querySelector('#aspect button.active')?.dataset.value ?? '16:9';
  const bpm = parseFloat($('bpm-override').value);
  return {
    aspect,
    fps: parseInt($('fps').value, 10),
    encoder: $('encoder').value,
    crf: parseInt($('crf').value, 10),
    supersample: parseInt($('supersample').value, 10),
    seed: Math.max(1, parseInt($('seed').value, 10) || 1),
    randomSeedEachRun: $('random-seed').checked,
    openingEffect: $('opening-effect').value,
    saveTrimmedCopy: $('trim-enabled').checked,
    trimMinutes: Math.max(0.25, parseFloat($('trim-minutes').value) || 4),
    trimTargetMb: Math.max(0, parseFloat($('trim-mb').value) || 0),
    bpmOverride: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    downbeatOffsetOverride: null,
    lyricAlignment: state.detail?.settings?.lyricAlignment ?? 'auto',
    whisperModel: state.detail?.settings?.whisperModel ?? 'medium',
    ltx: {
      enabled: $('ltx-enabled').checked,
      maxInserts: Math.max(1, parseInt($('ltx-count').value, 10) || 6),
      clipSeconds: 5,
      initMode: $('ltx-init').value,
      promptEnhance: $('ltx-enhance').checked,
      comfyUrl: state.detail?.settings?.ltx?.comfyUrl ?? 'http://127.0.0.1:8188',
      comfyRoot: state.detail?.settings?.ltx?.comfyRoot ?? 'D:\\AI\\ComfyUI\\ComfyUI',
    },
  };
}

let saveTimer = null;
function saveSettingsSoon() {
  if (!state.project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api(`api/projects/${encodeURIComponent(state.project)}/settings`, {
        method: 'PUT',
        body: JSON.stringify(collectSettings()),
      });
    } catch (e) { showWarnings([`Could not save settings: ${e.message}`], true); }
  }, 250);
}

// ------------------------------------------------------------------ analysis

async function loadAnalysis() {
  try {
    const a = await api(`api/projects/${encodeURIComponent(state.project)}/analysis`);
    state.analysis = a;
    renderAnalysis(a);
    setRunButtons(!state.running);
  } catch {
    state.analysis = null;
    $('analysis-panel').classList.add('hidden');
  }
}

function renderAnalysis(a) {
  $('analysis-panel').classList.remove('hidden');

  const lowConf = a.bpmConfidence < 0.4;
  $('analysis-summary').innerHTML = `
    <span>Duration <b>${fmtTime(a.duration)}</b></span>
    <span>Tempo <b>${a.bpm.toFixed(1)} BPM</b></span>
    <span class="${lowConf ? 'conf-low' : ''}">Confidence <b>${Math.round(a.bpmConfidence * 100)}%</b>${
      lowConf ? ' — grid not trusted, using sections + level' : ''}</span>
    <span>Beats <b>${a.beats.length}</b></span>
    <span>Sections <b>${a.sections.length}</b></span>
    <span>Lyric lines <b>${a.lyrics.filter((l) => !l.isMarker).length}</b></span>`;

  $('bpm-readout').innerHTML = `<b>${a.bpm.toFixed(1)} BPM</b> at ${
    Math.round(a.bpmConfidence * 100)}% confidence${
    lowConf ? '<br><span style="color:var(--warn)">Low — consider pinning it.</span>' : ''}`;

  drawWaveform(a);
  drawSections(a);
}

async function drawWaveform(a) {
  const canvas = $('waveform');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  canvas.width = cssW * dpr;
  canvas.height = 150 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, 150);

  let wave = null;
  try { wave = await api(`api/projects/${encodeURIComponent(state.project)}/waveform`); } catch { /* optional */ }

  const mid = 75;
  if (wave) {
    ctx.fillStyle = '#2c4a70';
    for (let x = 0; x < cssW; x++) {
      const i = Math.floor((x / cssW) * wave.max.length);
      const hi = (wave.max[i] ?? 0) * 70;
      const lo = (wave.min[i] ?? 0) * 70;
      ctx.fillRect(x, mid - hi, 1, Math.max(1, hi - lo));
    }
  }

  // Beat grid — thin ticks, downbeats taller, so alignment is checkable by eye.
  const toX = (t) => (t / a.duration) * cssW;
  ctx.strokeStyle = 'rgba(78,168,255,0.22)';
  ctx.beginPath();
  for (const b of a.beats) { const x = toX(b); ctx.moveTo(x, mid - 74); ctx.lineTo(x, mid + 74); }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,78,168,0.55)';
  ctx.beginPath();
  for (const d of a.downbeats) { const x = toX(d); ctx.moveTo(x, 0); ctx.lineTo(x, 150); }
  ctx.stroke();

  // Section boundaries.
  ctx.strokeStyle = 'rgba(230,235,245,0.5)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (const s of a.sections) { const x = toX(s.start); ctx.moveTo(x, 0); ctx.lineTo(x, 150); }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawSections(a) {
  const strip = $('section-strip');
  const hue = (label) => (label.charCodeAt(0) - 65) * 47 % 360;
  strip.innerHTML = a.sections.map((s) => {
    const w = ((s.end - s.start) / a.duration) * 100;
    const marker = s.markers?.[0] ?? '';
    const title = `${fmtTime(s.start)}–${fmtTime(s.end)} · ${s.label} · energy ${s.energy.toFixed(2)}${
      marker ? ` · ${marker}` : ''}`;
    return `<div style="flex:0 0 ${w}%;background:hsl(${hue(s.label)} 55% ${
      35 + s.energy * 35}%)" title="${escapeHtml(title)}">${escapeHtml(s.label)}</div>`;
  }).join('');
}

// ------------------------------------------------------------------ storyboard

async function loadStoryboard() {
  try {
    const sb = await api(`api/projects/${encodeURIComponent(state.project)}/storyboard`);
    state.storyboard = sb;
    renderStoryboard(sb);
  } catch {
    state.storyboard = null;
    $('storyboard-panel').classList.add('hidden');
  }
  // "Render this storyboard" is gated on there being one. This runs after the other
  // loaders, so without it the button reflects whichever project was open before.
  setRunButtons(!state.running);
}

function renderStoryboard(sb) {
  $('storyboard-panel').classList.remove('hidden');

  // The list scrolls, and changing an effect redraws all of it. Without this,
  // editing scene 20 throws the view back to scene 1 every time.
  const scroll = $('storyboard').scrollTop;

  const locked = sb.scenes.filter((s) => s.locked).length;
  $('sb-meta').textContent =
    `${sb.scenes.length} scenes · palette ${sb.palette} · seed ${sb.seed}` +
    (sb.mood ? ` · ${sb.mood}` : '') +
    (locked ? ` · ${locked} chosen by hand, kept when you re-plan` : '');

  $('storyboard').innerHTML = sb.scenes.map((s) => `
    <div class="scene${s.locked ? ' locked' : ''}" data-index="${s.index}">
      <div class="idx">${s.index + 1}</div>
      <div class="time">${fmtTime(s.start)}–${fmtTime(s.end)}</div>
      <div>
        <select class="eff-pick" data-index="${s.index}"
                title="Swap the effect for this scene">${sceneOptions(sb, s)}</select>
        <span class="meta"> — ${escapeHtml(s.why)} · in via ${escapeHtml(s.transitionIn)}</span>
        <div class="chips">
          ${s.post.map((p) => `<span class="chip">${escapeHtml(p.effectId)}</span>`).join('')}
          <span class="chip">energy ${s.energy.toFixed(2)}</span>
          <span class="chip">${escapeHtml(s.sectionLabel)}</span>
        </div>
      </div>
    </div>`).join('');

  $('storyboard').scrollTop = scroll;
}

/// The effects this scene could use instead. Ordered by whether they suit the
/// section's energy, because that is the question the user is actually asking when
/// they open the list - a calm effect on a peak is the one mistake worth steering
/// away from, and the director will not make it for them here.
function sceneOptions(sb, scene) {
  const pool = state.effects
    .filter((e) => SCENE_KINDS.includes(e.kind))
    .filter((e) => !e.aspects?.length || e.aspects.includes(sb.aspect));

  // The band as declared, with none of the slack the director allows itself when
  // nothing else is eligible. This is a hint for a person choosing on purpose, and
  // a group that holds 43 of 45 effects tells them nothing.
  const fits = (e) => scene.energy >= (e.energyRange?.[0] ?? 0)
                   && scene.energy <= (e.energyRange?.[1] ?? 1);

  const label = (e) => `${e.name || e.id} — energy ${e.energyRange?.[0] ?? 0}–${e.energyRange?.[1] ?? 1}`;
  const option = (e) => `<option value="${escapeHtml(e.id)}"${e.id === scene.effectId ? ' selected' : ''}
      title="${escapeHtml(e.description ?? '')}">${escapeHtml(label(e))}</option>`;

  const byName = (a, b) => (a.name || a.id).localeCompare(b.name || b.id);
  const suited = pool.filter(fits).sort(byName);
  const rest = pool.filter((e) => !fits(e)).sort(byName);

  // The row always shows the effect the scene actually uses, chosen by hand or not -
  // this is the scene list, and "Auto" in place of the effect would be hiding the one
  // thing it is for. Picking Auto hands the scene back to the director.
  const opts = [
    '<option value="">Auto — director picks</option>',
    suited.length ? `<optgroup label="Suits this section">${suited.map(option).join('')}</optgroup>` : '',
    rest.length ? `<optgroup label="Outside its energy band">${rest.map(option).join('')}</optgroup>` : '',
  ];

  // An effect that is no longer in the library still has to be visible: the plan
  // names it, the render will fail on it, and a silent Auto would hide both facts.
  if (scene.effectId && !pool.some((e) => e.id === scene.effectId))
    opts.push(`<option value="${escapeHtml(scene.effectId)}" selected
      >${escapeHtml(scene.effectId)} — not available</option>`);

  return opts.join('');
}

/// Swap one scene's effect. Saved immediately and remembered as a hand pick, so
/// re-planning keeps it - otherwise the next Generate would quietly undo the edit.
async function replaceEffect(index, effectId) {
  try {
    const scene = await api(
      `api/projects/${encodeURIComponent(state.project)}/storyboard/scene/${index}`,
      { method: 'PUT', body: JSON.stringify({ effectId }) });

    if (state.storyboard) {
      state.storyboard.scenes[index] = scene;
      renderStoryboard(state.storyboard);
    }
    hideWarnings();
  } catch (e) {
    showWarnings([`Could not change scene ${index + 1}: ${e.message}`], true);
    await loadStoryboard();   // put the row back to whatever is actually on disk
  }
}

$('storyboard').addEventListener('change', (e) => {
  const sel = e.target.closest('.eff-pick');
  if (sel) replaceEffect(Number(sel.dataset.index), sel.value);
});

// ------------------------------------------------------------------ result

function showResult() {
  const out = state.detail?.output;
  if (!out) { $('result-panel').classList.add('hidden'); return; }
  $('result-panel').classList.remove('hidden');
  // Cache-bust so a re-render is not masked by the previously played file.
  $('result-video').src = `${out}?v=${Date.now()}`;
  $('result-path').textContent = out.replace('/media/', '');
}

// ------------------------------------------------------------------ actions

$('project-select').addEventListener('change', (e) => selectProject(e.target.value));

for (const id of ['btn-new', 'btn-new-2']) {
  $(id).addEventListener('click', async () => {
    const name = prompt('Project name');
    if (!name) return;
    try {
      await api('api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      state.project = name;
      await refreshProjects();
    } catch (e) { showWarnings([e.message], true); }
  });
}

$('btn-import').addEventListener('click', () => {
  // Photino's native picker is the only way to get a real filesystem path. In
  // browser (--serve) mode there is no bridge, so fall back to typing one.
  if (window.external?.sendMessage) {
    window.external.sendMessage(JSON.stringify({ cmd: 'pickMp3' }));
  } else {
    $('import-fallback').classList.toggle('hidden');
  }
});

$('btn-import-path').addEventListener('click', () => importMp3($('import-path').value.trim()));

async function importMp3(path) {
  if (!path) return;
  try {
    await api(`api/projects/${encodeURIComponent(state.project)}/import`,
      { method: 'POST', body: JSON.stringify({ path }) });
    state.analysis = null;
    state.storyboard = null;
    $('analysis-panel').classList.add('hidden');
    $('storyboard-panel').classList.add('hidden');
    resetStages();
    await refreshProject();
  } catch (e) { showWarnings([e.message], true); }
}

if (window.external?.receiveMessage) {
  window.external.receiveMessage((raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.cmd !== 'pickedMp3') return;
    if (msg.error) { showWarnings([msg.error], true); return; }
    if (msg.path) importMp3(msg.path);
  });
}

$('btn-analyze').addEventListener('click', async () => {
  resetStages();
  $('btn-analyze').disabled = true;
  try {
    await api(`api/projects/${encodeURIComponent(state.project)}/settings`,
      { method: 'PUT', body: JSON.stringify(collectSettings()) });
    await api(`api/projects/${encodeURIComponent(state.project)}/analyze`, { method: 'POST' });
    await loadAnalysis();
    // Analysing now plans as well, so the scenes are there to be reviewed and
    // edited without having to render a video first.
    await loadStoryboard();
  } catch (e) {
    showWarnings([e.message], true);
  } finally {
    $('btn-analyze').disabled = false;
  }
});

/// Shared launcher for every kind of run; `body` decides which stages happen.
async function startRun(body) {
  resetStages();
  state.running = true;
  setRunButtons(false);
  $('btn-cancel').classList.remove('hidden');
  try {
    await api(`api/projects/${encodeURIComponent(state.project)}/settings`,
      { method: 'PUT', body: JSON.stringify(collectSettings()) });
    await api(`api/projects/${encodeURIComponent(state.project)}/generate`,
      { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    state.running = false;
    setRunButtons(true);
    $('btn-cancel').classList.add('hidden');
    showWarnings([e.message], true);
  }
}

function setRunButtons(enabled) {
  const hasAnalysis = !!state.analysis;
  const hasStoryboard = !!state.storyboard;
  $('btn-generate').disabled = !enabled || !hasAnalysis;
  $('btn-plan').disabled = !enabled || !hasAnalysis;
  $('btn-render-existing').disabled = !enabled || !hasStoryboard;
  $('btn-analyze').disabled = !enabled;
  // Nothing to shorten until a full render exists in the output folder.
  $('btn-trim-now').disabled = !enabled || !state.detail?.output;
}

$('btn-generate').addEventListener('click', () => startRun({
  useLlm: $('use-llm').checked,
  generateLtx: $('ltx-enabled').checked,
  force: false,
}));

// Re-plan only: the director runs again and writes storyboard.json, nothing is
// rendered. Seconds rather than minutes, which makes rerolling actually usable -
// unless LTX is on, in which case the new plan's inserts have to be generated
// before the storyboard describes a complete video.
$('btn-plan').addEventListener('click', () => startRun({
  useLlm: $('use-llm').checked,
  generateLtx: $('ltx-enabled').checked,
  planOnly: true,
}));

$('btn-render-existing').addEventListener('click', () => startRun({
  useExistingStoryboard: true,
}));

$('btn-cancel').addEventListener('click', () => api('api/cancel', { method: 'POST' }));

// Shorten the MP4 that is already on disk. No re-render, and the full file is
// left alone - this is the escape hatch for a render that finished with the
// checkbox unticked.
$('btn-trim-now').addEventListener('click', async () => {
  if (!state.project || state.running) return;
  state.running = true;
  state.trimOnly = true;
  setRunButtons(false);
  setTrimStatus('Working…');
  try {
    // Save first: the trim reads Length and Max size from project.json, and the
    // debounced autosave may not have landed yet.
    await api(`api/projects/${encodeURIComponent(state.project)}/settings`,
      { method: 'PUT', body: JSON.stringify(collectSettings()) });
    await api(`api/projects/${encodeURIComponent(state.project)}/trim`, { method: 'POST' });
  } catch (e) {
    state.running = false;
    state.trimOnly = false;
    setRunButtons(true);
    setTrimStatus(e.message, true);
  }
});

$('btn-reroll').addEventListener('click', () => {
  $('seed').value = String(Math.floor(Math.random() * 100000) + 1);
  // Re-plan straight away: a new seed with no visible consequence is a
  // button that appears to do nothing.
  if (state.analysis) startRun({ useLlm: $('use-llm').checked, planOnly: true });
  else saveSettingsSoon();
});

// Pin a different opener at random. Same reasoning as Reroll: without the
// re-plan the choice has no visible consequence and the button looks dead.
$('btn-opener-surprise').addEventListener('click', () => {
  const sel = $('opening-effect');
  const ids = [...sel.options].map((o) => o.value).filter((v) => v && v !== sel.value);
  if (!ids.length) return;
  sel.value = ids[Math.floor(Math.random() * ids.length)];
  if (state.analysis && !state.running) startRun({ useLlm: $('use-llm').checked, planOnly: true });
  else saveSettingsSoon();
});

$('crf').addEventListener('input', () => { $('crf-out').textContent = $('crf').value; });

for (const b of document.querySelectorAll('#aspect button')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('#aspect button')) o.classList.remove('active');
    b.classList.add('active');
    // Effects declare which aspects they support, so the pool changes with it.
    populateOpeners(b.dataset.value, $('opening-effect').value);
    saveSettingsSoon();
  });
}

for (const id of ['fps', 'encoder', 'crf', 'supersample', 'seed', 'random-seed', 'bpm-override',
                  'opening-effect', 'trim-enabled', 'trim-minutes', 'trim-mb',
                  'ltx-enabled', 'ltx-count', 'ltx-init', 'ltx-enhance']) {
  $(id).addEventListener('change', saveSettingsSoon);
}

$('btn-open-folder').addEventListener('click', () => {
  const p = state.detail?.output;
  if (p) window.open(p.substring(0, p.lastIndexOf('/')), '_blank');
});

// ------------------------------------------------------------------ helpers

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ boot

buildStages();
// Effects first: the project's settings are applied to the panel as soon as it
// loads, and the opening-effect dropdown has to have its options by then.
loadEffects()
  .then(refreshProjects)
  .catch((e) => showWarnings([e.message], true));
