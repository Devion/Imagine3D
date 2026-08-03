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
    bool Force = false);
