namespace Imagine3D.Direct;

/// The contract between the director and the renderer. Fully inspectable and
/// hand-editable: delete a scene, swap an effect id, change a parameter expression
/// and re-render without re-analysing anything.
public sealed record Storyboard(
    int Version,
    int Seed,
    string Aspect,
    int Fps,
    double Duration,
    string Mood,
    string Palette,
    string Notes,
    StoryScene[] Scenes,
    TextCue[] Texts,
    LtxInsert[] Ltx)
{
    public const int CurrentVersion = 1;

    public int TotalFrames => (int)Math.Ceiling(Duration * Fps);
}

/// One scene: a primary visual for a span of the song, plus the post-processing
/// stack layered on top of it and the transition that brings it in.
public sealed record StoryScene(
    int Index,
    double Start,
    double End,
    string EffectId,
    Dictionary<string, string> Params,
    PostEffect[] Post,
    string TransitionIn,
    double TransitionDuration,
    string SectionLabel,
    double Energy,
    string Why,
    /// Optional sustained blend with the previous scene. When set, the two scenes
    /// are composited together for a stretch rather than one simply replacing the
    /// other at a cut.
    SceneBlend? Blend = null)
{
    public double Duration => End - Start;
}

/// Layering of this scene over the previous one.
///
/// A cut is not always the right edit. Blending lets a new scene bleed through
/// the old one for a while - screen and add read as one image growing out of
/// another, multiply and difference read as interference between two.
public sealed record SceneBlend(
    /// Blend operator; see BLEND_MODES in engine/renderer.js.
    string Mode,
    /// Mix expression, 0..1. Can breathe with the music.
    string Amount,
    /// Seconds the underlying scene keeps being drawn. 0 means the whole scene,
    /// i.e. the two run layered from start to finish.
    double Duration,
    /// Ramp in and out of the blend, in seconds, so it never pops.
    double Fade);

/// A post-processing pass. `Amount` is the overall wet/dry, itself an expression so
/// it can breathe with the music.
public sealed record PostEffect(
    string EffectId,
    Dictionary<string, string> Params,
    string Amount);

/// A lyric or scroller drawn over the scene.
public sealed record TextCue(
    double Start,
    double End,
    string Text,
    string Style);

/// An LTX clip mixed into the demo. `Blend` is the shader blend mode - this is
/// where MUL/XOR/screen live.
public sealed record LtxInsert(
    int Index,
    double Start,
    double Duration,
    string ClipFile,
    string Blend,
    string Opacity,
    string Prompt,
    string InitMode);
