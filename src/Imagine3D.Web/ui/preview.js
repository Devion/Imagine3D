// Interactive front-end for the contact sheet. All the work is in sheet.js so the
// backend can drive the same code without a person clicking anything.

import { renderContactSheet, captureSheetToDisk } from './sheet.js';
import { PALETTE_NAMES } from '../engine/palettes.js';

const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; };

$('palette').innerHTML = PALETTE_NAMES.map((p) => `<option>${p}</option>`).join('');
$('palette').value = 'neon';

async function draw() {
  status('rendering…');
  const { canvas, failures, count } = await renderContactSheet({
    kind: $('kind').value,
    palette: $('palette').value,
    onStatus: status,
  });

  const sheet = $('sheet');
  sheet.width = canvas.width;
  sheet.height = canvas.height;
  sheet.getContext('2d').drawImage(canvas, 0, 0);

  status(`${count} effects, ${failures.length} failed${failures.length ? `: ${failures.join(' | ')}` : ''}`);
}

$('go').addEventListener('click', () => draw().catch((e) => status(`error: ${e.message}`)));

$('upload').addEventListener('click', async () => {
  status('rendering and saving…');
  try {
    const { path, failures } = await captureSheetToDisk({
      kind: $('kind').value, palette: $('palette').value, onStatus: status,
    });
    status(`saved ${path}${failures.length ? ` — ${failures.length} failed` : ''}`);
  } catch (e) { status(`error: ${e.message}`); }
});

draw().catch((e) => status(`error: ${e.message}`));
