using System.Text.Json.Serialization;

namespace Imagine3D.Projects;

/// Everything that makes a render reproducible. Persisted as project.json.
public sealed class ProjectSettings
{
    public string Name { get; set; } = "";

    /// "16:9" or "9:16". Drives Width/Height when they are left at 0.
    public string Aspect { get; set; } = "16:9";

    public int Width { get; set; }
    public int Height { get; set; }
    public int Fps { get; set; } = 30;

    /// Seeds every RNG in the director and the effects, so the same project always
    /// renders the same video. "Reroll" is an explicit bump of this number.
    public int Seed { get; set; } = 1;

    /// Roll a fresh Seed at the start of every planning run.
    ///
    /// Without this a new project starts at seed 1 and stays there, so separate
    /// songs are planned from an identical RNG stream and keep making the same
    /// opening choice. The roll is written back to project.json before the
    /// storyboard is built, so a video is still exactly reproducible - turn this
    /// off and type the seed the storyboard records.
    public bool RandomSeedEachRun { get; set; } = true;

    /// "libx264" (compatible) or "h264_nvenc" / "hevc_nvenc" (fast on the 5090).
    public string Encoder { get; set; } = "libx264";
    public int Crf { get; set; } = 18;

    /// Render at N x the output size then downscale - crisper demoscene look.
    public int Supersample { get; set; } = 1;

    /// Effect id for the first scene; "" lets the director choose.
    ///
    /// The opening pick is the one the director has the least to go on: there is
    /// no history to penalise, intros are nearly always low-energy, and every new
    /// project starts on the same seed - so separate songs keep opening with the
    /// same effect. Pinning one here breaks that without touching the rest of the
    /// storyboard. An id that no longer exists is ignored, not an error.
    public string OpeningEffect { get; set; } = "";

    /// Also write a shortened copy of the finished video alongside the full one,
    /// for platforms with a length cap. The full render is never replaced.
    public bool SaveTrimmedCopy { get; set; }

    /// Length of that copy, in minutes.
    public double TrimMinutes { get; set; } = 4;

    /// Size ceiling for the copy, in MB. 0 keeps the fast lossless stream copy;
    /// anything above re-encodes two-pass to land under the limit.
    public double TrimTargetMb { get; set; }

    /// Beat tracking on rubato material is unreliable; these let the user pin it.
    public double? BpmOverride { get; set; }
    public double? DownbeatOffsetOverride { get; set; }

    /// "auto" uses Whisper forced alignment when a suitable Python is present and
    /// falls back to distributing lines across sections; "whisper" requires it;
    /// "structural" never runs it.
    public string LyricAlignment { get; set; } = "auto";

    /// tiny | base | small | medium | large. Bigger models find more anchor words
    /// on dense mixes; medium is the best accuracy-per-second on this material.
    public string WhisperModel { get; set; } = "medium";

    public LtxSettings Ltx { get; set; } = new();

    public ImageSettings Images { get; set; } = new();

    /// Populated by the analyser, surfaced in the UI. Not user-editable.
    public string? SourceMp3 { get; set; }
    public string? SourceTxt { get; set; }

    [JsonIgnore]
    public (int W, int H) Resolution
    {
        get
        {
            if (Width > 0 && Height > 0) return (Width, Height);
            return Aspect == "9:16" ? (1080, 1920) : (1920, 1080);
        }
    }

    /// x264 wants even dimensions; the supersampled buffer must stay a clean multiple.
    public (int W, int H) RenderResolution
    {
        get
        {
            var (w, h) = Resolution;
            int s = Math.Clamp(Supersample, 1, 4);
            return (Even(w * s), Even(h * s));
        }
    }

    static int Even(int v) => v % 2 == 0 ? v : v + 1;

    public void Normalize()
    {
        if (Aspect is not ("16:9" or "9:16")) Aspect = "16:9";
        Fps = Math.Clamp(Fps, 12, 60);
        Crf = Math.Clamp(Crf, 0, 51);
        Supersample = Math.Clamp(Supersample, 1, 4);
        OpeningEffect = (OpeningEffect ?? "").Trim();
        TrimMinutes = Math.Clamp(TrimMinutes, 0.25, 60);
        TrimTargetMb = TrimTargetMb <= 0 ? 0 : Math.Clamp(TrimTargetMb, 5, 4000);
        Images ??= new ImageSettings();      // absent from a project.json written before images existed
        Images.Normalize();
        if (Seed == 0) Seed = 1;
        var (w, h) = Resolution;
        Width = Even(w);
        Height = Even(h);
    }
}

/// How the project's own images are used. The files live in images/; this says
/// how freely the director may reach for them.
public sealed class ImageSettings
{
    /// Off means the director never places one, however many are in the folder.
    /// On with an empty folder costs nothing, so this stays on by default.
    public bool Enabled { get; set; } = true;

    /// Roughly what share of scenes may carry an image, 0..1. Which scenes is
    /// still the director's decision, and a long scene takes two or three separate
    /// hits rather than one hold - this only says how much of the video the images
    /// are allowed to reach.
    public double Density { get; set; } = 0.4;

    /// How many times one image may appear when there are fewer images than the
    /// density asks for.
    ///
    /// Uniqueness is the point: with twenty images and nine hits every hit gets
    /// its own picture. With one image and nine hits, nine appearances of the same
    /// photograph is not nine events, it is a background - so the count is capped
    /// at what the library can cover without repeating itself into wallpaper.
    public int MaxUsesPerImage { get; set; } = 3;

    public void Normalize()
    {
        Density = Math.Clamp(Density, 0, 1);
        MaxUsesPerImage = Math.Clamp(MaxUsesPerImage, 1, 20);
    }
}

public sealed class LtxSettings
{
    public bool Enabled { get; set; } = false;
    public int MaxInserts { get; set; } = 6;
    public double ClipSeconds { get; set; } = 5;

    /// "render" uses a frame from our own 3D scene as the LTX init image, so the
    /// clip flows out of the demo instead of cutting to unrelated imagery.
    /// "sdxl" generates a fresh key frame instead.
    public string InitMode { get; set; } = "render";

    /// The graph's Gemma prompt rewriter. Off by default: it paraphrases every
    /// clip independently, which is what breaks look continuity between them.
    public bool PromptEnhance { get; set; }

    public string ComfyUrl { get; set; } = "http://127.0.0.1:8188";
    public string ComfyRoot { get; set; } = @"D:\AI\ComfyUI\ComfyUI";
}
