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

    /// "libx264" (compatible) or "h264_nvenc" / "hevc_nvenc" (fast on the 5090).
    public string Encoder { get; set; } = "libx264";
    public int Crf { get; set; } = 18;

    /// Render at N x the output size then downscale - crisper demoscene look.
    public int Supersample { get; set; } = 1;

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
        if (Seed == 0) Seed = 1;
        var (w, h) = Resolution;
        Width = Even(w);
        Height = Even(h);
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

    public string ComfyUrl { get; set; } = "http://127.0.0.1:8188";
    public string ComfyRoot { get; set; } = @"D:\AI\ComfyUI\ComfyUI";
}
