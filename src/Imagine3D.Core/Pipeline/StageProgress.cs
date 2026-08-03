namespace Imagine3D.Pipeline;

public enum PipelineStage
{
    Analyze,
    Intent,
    Storyboard,
    Ltx,
    Render,
    Encode,
    Done,
}

/// One progress tick from any stage. `Fraction` is 0..1 within the stage;
/// `Detail` is the human-readable line the UI shows next to the bar.
public sealed record StageProgress(
    PipelineStage Stage,
    double Fraction,
    string Detail,
    string? Thumbnail = null,
    bool Failed = false);

public sealed record PipelineOptions(
    bool UseLlm = true,
    bool GenerateLtx = false,
    bool Force = false,
    /// Render plan/storyboard.json exactly as it is on disk, skipping the intent
    /// and director stages. This is what makes the storyboard editable: change an
    /// effect id or a parameter expression by hand and render that, rather than
    /// having the director immediately overwrite your edit.
    bool UseExistingStoryboard = false,
    /// Stop after writing plan/storyboard.json. Choosing scenes takes a second;
    /// rendering them takes minutes, so this is the loop for iterating on the
    /// director's decisions.
    bool PlanOnly = false);
