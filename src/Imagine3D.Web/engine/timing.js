// Keep the music's segment boundaries on disk; delay only the visual edit.
export function effectiveScenes(storyboard) {
  const scenes = storyboard.scenes;
  const extra = scenes.map((s, i) => {
    const max = i + 1 < scenes.length
      ? Math.max(0, scenes[i + 1].end - scenes[i + 1].start - 1 / storyboard.fps) : 0;
    return Math.min(max, Math.max(0, Number(s.extendSeconds) || 0));
  });
  return scenes.map((s, i) => ({ ...s, sourceStart: s.start, sourceEnd: s.end,
    start: s.start + (i ? extra[i - 1] : 0), end: s.end + extra[i],
  }));
}
