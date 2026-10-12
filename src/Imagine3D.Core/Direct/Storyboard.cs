using Imagine3D.Audio;
using Imagine3D.Projects;

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
    LtxInsert[] Ltx,
    /// Project images placed into the picture. Null in a plan written before the
    /// project had any, which is a plan with no images rather than a broken one.
    ImageCue[]? Images = null)
{
    public const int CurrentVersion = 1;

    public int TotalFrames => (int)Math.Ceiling(Duration * Fps);

    /// Why this plan no longer describes the given song at the given settings, or
    /// null when it still does and can simply be rendered.
    ///
    /// This is what lets Generate render the storyboard the user is looking at
    /// instead of quietly building another one. Only things that move the scenes
    /// count: a different shape or frame rate of video, a song of a different
    /// length, a seed asked for by hand. Everything else - encoder, CRF, trimming,
    /// the LTX switches - is applied downstream of the director and changes nothing
    /// about which effect sits where, so it must not throw away a plan that has
    /// been reviewed and hand-edited.
    public string? StaleBecause(ProjectSettings settings, AudioAnalysis analysis) =>
        Version != CurrentVersion
            ? "the plan on disk was written by an older version"
        : Scenes.Length == 0
            ? "the plan on disk has no scenes in it"
        : !string.Equals(Aspect, settings.Aspect, StringComparison.OrdinalIgnoreCase)
            ? $"the plan is {Aspect} and you asked for {settings.Aspect}"
        : Fps != settings.Fps
            ? $"the plan is {Fps} fps and you asked for {settings.Fps}"
        // Sections, and so scene boundaries, are derived from the song. A different
        // length means a different analysis, and the old spans no longer line up
        // with the music they were chosen for.
        : Math.Abs(Duration - analysis.Duration) > 0.25
            ? "the song is a different length than when it was planned"
        // With a fresh seed rolled at every plan the field is not a request, so the
        // plan cannot be stale against it. Typed by hand it is exactly that.
        : !settings.RandomSeedEachRun && Seed != settings.Seed
            ? $"you asked for seed {settings.Seed}"
        : null;
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
    SceneBlend? Blend = null,

    /// Set when the effect was chosen by hand rather than by the director. Re-planning
    /// keeps it, so picking an effect in the UI and then pressing Generate does not
    /// silently throw the choice away.
    bool Locked = false,
    /// Seconds to hold this shot into the following segment before its transition.
    double ExtendSeconds = 0)
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

/// One of the project's images, placed into a scene.
///
/// The pass runs between the scene and that scene's own post stack, not after
/// the transition the way an LTX insert does. An image is part of the picture
/// rather than something laid over the finished frame: it is pixelated by the
/// scene's pixelate, bent by its CRT, and it arrives and leaves through the same
/// transition the scene does. Composited afterwards it reads as a sticker.
public sealed record ImageCue(
    int Index,
    /// The scene this belongs to. An image is a property of a shot, so a cue can
    /// never outlive the scene that owns it or bleed into the next one.
    int SceneIndex,
    double Start,
    double End,
    string File,
    /// "behind" keys the image in underneath the scene, using the scene's own
    /// luminance as its alpha - these effects draw on black, so what they light
    /// up is exactly what should sit in front of the photo. "over" composites it
    /// on top with `Blend`, which is interference rather than a backdrop.
    /// "effect" means the scene's own shader is drawing the picture.
    string Placement,
    /// What is being done to the picture while it is on screen - ripple, wave,
    /// swirl, kaleido, tunnel, slice, mosaic, bulge. See IMAGE_TREATMENTS in
    /// engine/renderer.js and imageWarp() in shaders/image.glsl.
    ///
    /// Never absent. A photograph that is only faded in and out is a photograph
    /// pasted into the video, and it goes stale in about two seconds.
    string Treatment,
    /// Blend operator for "over"; ignored by "behind". See BLEND_MODES.
    string Blend,
    /// Mix expression, 0..1. `imageT` runs 0..1 across the cue, so this is also
    /// where the fade in and out lives.
    string Opacity,
    /// Expressions for the imagelayer pass - zoom, drift, warp, tone, key.
    Dictionary<string, string> Params,
    string Why);

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
