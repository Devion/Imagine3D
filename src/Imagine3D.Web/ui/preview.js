// Page controller for the effect gallery.
//
// The gallery itself is in gallery.js - this wires it to the selects and the
// transport, and keeps the old one-still-per-effect contact sheet available
// underneath, because that is what the backend drives through /api/devsheet and
// what gets saved to disk for review.

import { Gallery } from './gallery.js';
import { renderContactSheet, captureSheetToDisk } from './sheet.js';
import { PALETTE_NAMES } from '../engine/palettes.js';

const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; };

const mmss = (t) => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  return `${m}:${String(Math.floor(t - m * 60)).padStart(2, '0')}`;
};

$('palette').innerHTML = PALETTE_NAMES.map((p) => `<option>${p}</option>`).join('');
$('palette').value = 'neon';

let gallery;
// True while the user is dragging the scrub, so the clock does not fight them.
let scrubbing = false;

function paintClock(t) {
  $('clock').textContent = `${mmss(t)} / ${mmss(gallery.duration)}`;
  if (!scrubbing) $('scrub').value = String(Math.round(1000 * t / Math.max(1, gallery.duration)));
}

function summary() {
  const n = gallery.playing.size;
  status(n === 0
    ? `${gallery.cards.size} effects — press play on a card, or “Play visible”.`
    : `${n} playing (only the ones on screen are drawn) — ${gallery.cards.size} effects loaded.`);
}

async function loadKind() {
  status('loading effects…');
  const n = await gallery.load($('kind').value);
  status(`${n} effects — press play on a card, or “Play visible”.`);
  paintClock(gallery.now());
}

async function pickProject(name) {
  const info = await gallery.setProject(name || null);
  $('audio').disabled = !info?.audio;

  if (!name) {
    $('bpm').textContent = 'no project — synthetic 124 BPM';
  } else if (!info?.bpm) {
    $('bpm').textContent = `${name}: not analysed yet — synthetic 124 BPM`;
  } else {
    $('bpm').textContent = `${info.bpm.toFixed(1)} BPM`;
  }
  $('audio').textContent = 'Play audio';
  paintClock(gallery.now());
}

async function init() {
  gallery = new Gallery($('gallery'), {
    onStatus: (t) => paintClock(t),
    onProgress: (done, total) => status(`compiling shaders… ${done}/${total}`),
  });

  const url = new URLSearchParams(location.search);
  if (url.get('kind')) $('kind').value = url.get('kind');
  if (url.get('palette')) $('palette').value = url.get('palette');

  await loadKind();

  // Projects, newest usable first. An unanalysed project is still listed - it
  // just falls back to the metronome, and saying so is better than hiding it.
  let projects = [];
  try { projects = await (await fetch('api/projects')).json(); } catch { /* offline */ }
  $('project').innerHTML =
    '<option value="">(no project — synthetic beat)</option>' +
    projects.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');

  const analysed = projects.find((p) => p.hasAnalysis) ?? projects[0];
  if (analysed) $('project').value = analysed.name;
  await pickProject($('project').value);

  $('project').addEventListener('change', () => pickProject($('project').value));
  $('kind').addEventListener('change', () => loadKind().then(summary));
  $('palette').addEventListener('change', () => gallery.setPalette($('palette').value));

  $('playVisible').addEventListener('click', () => gallery.playVisible().then(summary));
  $('stopAll').addEventListener('click', () => { gallery.stopAll(); summary(); });

  $('audio').addEventListener('click', async () => {
    const playing = await gallery.toggleAudio();
    $('audio').textContent = playing ? 'Pause audio' : 'Play audio';
  });

  $('scrub').addEventListener('input', () => {
    scrubbing = true;
    const t = gallery.duration * (Number($('scrub').value) / 1000);
    gallery.seek(t);
    paintClock(t);
    // Redraw the stills too, so scrubbing means something with nothing playing.
    if (gallery.playing.size === 0)
      for (const c of gallery.cards.values()) if (c.instance) gallery.drawCard(c, t);
  });
  $('scrub').addEventListener('change', () => { scrubbing = false; });

  // Space toggles the audio, which is what the hands expect on a transport.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    e.preventDefault();
    $('audio').click();
  });

  // Deep links: ?play=tunnel,fire&t=42 opens with those cards running from that
  // point in the song. Handy for "look at this one", and it is also the only way
  // to drive the page from a headless browser.
  const q = new URLSearchParams(location.search);
  if (q.get('t')) { gallery.seek(Number(q.get('t')) || 0); paintClock(gallery.now()); }
  for (const id of (q.get('play') ?? '').split(',').filter(Boolean)) {
    await gallery.start(id.trim());
    gallery.cards.get(id.trim())?.el.scrollIntoView({ block: 'center' });
  }

  summary();
}

// ---------------------------------------------------------------- contact sheet

$('go').addEventListener('click', async () => {
  $('sheet-status').textContent = 'rendering…';
  try {
    const { canvas, failures, count } = await renderContactSheet({
      kind: $('kind').value,
      palette: $('palette').value,
      onStatus: (s) => { $('sheet-status').textContent = s; },
    });
    const sheet = $('sheet');
    sheet.width = canvas.width;
    sheet.height = canvas.height;
    sheet.getContext('2d').drawImage(canvas, 0, 0);
    $('sheet-status').textContent =
      `${count} effects, ${failures.length} failed${failures.length ? `: ${failures.join(' | ')}` : ''}`;
  } catch (e) { $('sheet-status').textContent = `error: ${e.message}`; }
});

$('upload').addEventListener('click', async () => {
  $('sheet-status').textContent = 'rendering and saving…';
  try {
    const { path, failures } = await captureSheetToDisk({
      kind: $('kind').value, palette: $('palette').value,
      onStatus: (s) => { $('sheet-status').textContent = s; },
    });
    $('sheet-status').textContent = `saved ${path}${failures.length ? ` — ${failures.length} failed` : ''}`;
  } catch (e) { $('sheet-status').textContent = `error: ${e.message}`; }
});

init().catch((e) => status(`error: ${e.message}`));
