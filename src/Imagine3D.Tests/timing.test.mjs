import assert from 'node:assert/strict';
import { effectiveScenes } from '../Imagine3D.Web/engine/timing.js';
import { Renderer } from '../Imagine3D.Web/engine/renderer.js';
const plan = { fps: 30, scenes: [
  { index: 0, start: 0, end: 10, extendSeconds: 3 },
  { index: 1, start: 10, end: 20, extendSeconds: 2 },
  { index: 2, start: 20, end: 30, extendSeconds: 100 },
] };
const scenes = effectiveScenes(plan);
assert.deepEqual(scenes.map(s => [s.start, s.end]), [[0,13],[13,22],[22,30]]);
assert.equal(plan.scenes[0].end, 10);
const renderer = { storyboard: { scenes } };
for (const [time,index] of [[9.9,0],[10,0],[12.99,0],[13,1],[21,1],[22,2]])
  assert.equal(Renderer.prototype.sceneAt.call(renderer,time).index,index);
const extreme = effectiveScenes({ fps: 30, scenes: [
  { start: 0, end: 10, extendSeconds: 100 }, { start: 10, end: 11 },
] });
assert.ok(extreme[1].end - extreme[1].start >= 1/30 - 1e-10);
const cue = {sceneIndex: 0, start: 0, end: 10};
assert.equal(Renderer.prototype.imageCue.call({storyboard:{images:[cue]}},scenes[0],12),cue);
assert.deepEqual(effectiveScenes({fps:30,scenes:[{start:0,end:10}]}).map(s=>[s.start,s.end]),[[0,10]]);
console.log('PASS scene extension boundaries, clamping, legacy plans and image continuity');
