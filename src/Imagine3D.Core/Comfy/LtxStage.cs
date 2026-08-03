using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Imagine3D.Audio;
using Imagine3D.Direct;
using Imagine3D.Lyrics;
using Imagine3D.Media;
using Imagine3D.Pipeline;
using Imagine3D.Projects;

namespace Imagine3D.Comfy;

/// Generates short LTX clips and writes them into the storyboard as blended
/// inserts. The clips are *mixed into* the demo (MUL/XOR/screen/etc.), not cut to,
/// so a failed or skipped LTX stage still leaves a complete video.
public sealed class LtxStage(
    Ffmpeg ffmpeg,
    string workflowDir,
    Func<double, int, int, CancellationToken, Task<byte[]>>? snapshot = null)
{
    /// Blend modes, weighted toward the ones that read well over a moving demo.
    static readonly string[] Blends = ["screen", "add", "multiply", "difference", "overlay", "xor"];

    public async Task<Storyboard> RunAsync(
        ProjectPaths paths, ProjectSettings settings, AudioAnalysis analysis,
        Storyboard storyboard, IProgress<StageProgress> progress, CancellationToken ct)
    {
        var picks = PickInsertPoints(storyboard, analysis, settings);
        if (picks.Count == 0)
        {
            progress.Report(new StageProgress(PipelineStage.Ltx, 1.0, "No suitable insert points"));
            return storyboard;
        }

        Directory.CreateDirectory(paths.LtxDir);
        var cache = LoadCache(paths);
        var song = SongText.Parse(paths.FindTxt() is { } t ? File.ReadAllText(t) : null);

        using var comfy = new ComfyClient(
            settings.Ltx.ComfyUrl, settings.Ltx.ComfyRoot, workflowDir,
            log => progress.Report(new StageProgress(PipelineStage.Ltx, 0, log)));

        var (rw, rh) = settings.Resolution;
        // LTX wants multiples of 32, and generating at full output size is slow;
        // half size upscales fine because the clip is composited, not shown raw.
        int lw = RoundTo32(rw / 2), lh = RoundTo32(rh / 2);

        var inserts = new List<LtxInsert>();
        bool comfyUp = false;

        for (int i = 0; i < picks.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var (scene, start) = picks[i];
            double frac = i / (double)picks.Count;

            var prompt = BuildPrompt(song, scene, storyboard, analysis, start);
            var key = HashKey(prompt, lw, lh, settings.Ltx.ClipSeconds, settings.Seed + i);
            var clipPath = Path.Combine(paths.LtxDir, $"clip_{i + 1:D3}.mp4");

            if (cache.TryGetValue(key, out var cachedFile) && File.Exists(cachedFile))
            {
                progress.Report(new StageProgress(PipelineStage.Ltx, frac,
                    $"clip {i + 1}/{picks.Count} - cached"));
                inserts.Add(MakeInsert(i, start, settings, cachedFile, scene, storyboard.Seed));
                continue;
            }

            try
            {
                if (!comfyUp) { await comfy.EnsureUpAsync(ct); comfyUp = true; }

                progress.Report(new StageProgress(PipelineStage.Ltx, frac,
                    $"clip {i + 1}/{picks.Count} - {Trunc(prompt, 70)}"));

                var init = await MakeInitImageAsync(comfy, paths, settings, start, lw, lh, prompt, i, ct);

                // Token names match the working graph exactly: it takes a
                // %DURATION% in *seconds* and derives the frame count itself, and
                // it has no audio input - LTX synthesises its own, which we
                // discard because the original MP3 is muxed over everything.
                var produced = await comfy.RunAsync("LTX2_I2V.json", new Dictionary<string, object>
                {
                    ["%IMAGE%"] = comfy.StageInput(init),
                    ["%PROMPT%"] = prompt,
                    ["%NEGATIVE%"] = SongText.ComposeNegative(song.Negative, "text, watermark, blurry"),
                    ["%WIDTH%"] = lw,
                    ["%HEIGHT%"] = lh,
                    ["%DURATION%"] = (int)Math.Round(settings.Ltx.ClipSeconds),
                    ["%FPS%"] = settings.Fps,
                    // The graph's Gemma prompt rewriter. Off: it paraphrases each
                    // clip independently and breaks look continuity.
                    ["%ENHANCE%"] = settings.Ltx.PromptEnhance,
                    ["%SEED%"] = settings.Seed + i,
                    ["%OUTPUT_PREFIX%"] = $"i3d_{paths.Name}_{i + 1:D3}",
                }, isVideo: true, ct);

                File.Copy(produced, clipPath, overwrite: true);
                cache[key] = clipPath;
                SaveCache(paths, cache);
                inserts.Add(MakeInsert(i, start, settings, clipPath, scene, storyboard.Seed));
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception e)
            {
                // One failed clip must not lose the other clips or the video.
                progress.Report(new StageProgress(PipelineStage.Ltx, frac,
                    $"clip {i + 1} failed, continuing without it: {Trunc(e.Message, 100)}"));
            }
        }

        progress.Report(new StageProgress(PipelineStage.Ltx, 1.0,
            $"{inserts.Count}/{picks.Count} clips ready"));

        return storyboard with { Ltx = inserts.ToArray() };
    }

    /// Init frame. "render" grabs a frame from our own 3D scene at that timestamp,
    /// so the LTX clip grows out of the demo instead of cutting to something
    /// unrelated - it costs nothing extra because we are already rendering.
    async Task<string> MakeInitImageAsync(
        ComfyClient comfy, ProjectPaths paths, ProjectSettings settings,
        double t, int w, int h, string prompt, int index, CancellationToken ct)
    {
        var initPath = Path.Combine(paths.KeyframeDir, $"init_{index + 1:D3}.png");
        Directory.CreateDirectory(paths.KeyframeDir);

        if (settings.Ltx.InitMode == "render" && snapshot is not null)
        {
            // ffmpeg cannot read and write the same path in one invocation, so
            // the snapshot lands in its own file and is fitted into the final one.
            var raw = Path.Combine(paths.KeyframeDir, $"init_{index + 1:D3}_raw.png");
            var png = await snapshot(t, w, h, ct);
            await File.WriteAllBytesAsync(raw, png, ct);
            ffmpeg.FitImage(raw, initPath, w, h);
            return initPath;
        }

        var generated = await comfy.RunAsync("sdxlturbo.json", new Dictionary<string, object>
        {
            ["%PROMPT%"] = prompt,
            ["%NEGATIVE%"] = "text, watermark, blurry",
            ["%WIDTH%"] = w,
            ["%HEIGHT%"] = h,
            ["%SEED%"] = settings.Seed + index,
            ["%OUTPUT_PREFIX%"] = $"i3d_key_{index + 1:D3}",
        }, isVideo: false, ct);

        File.Copy(generated, initPath, overwrite: true);
        return initPath;
    }

    /// Spread inserts over the highest-energy scenes, keeping them apart so they
    /// punctuate the demo rather than clumping in one passage.
    static List<(StoryScene Scene, double Start)> PickInsertPoints(
        Storyboard sb, AudioAnalysis analysis, ProjectSettings settings)
    {
        var picks = new List<(StoryScene, double)>();
        double clip = settings.Ltx.ClipSeconds;
        double minGap = Math.Max(clip * 3, sb.Duration / Math.Max(1, settings.Ltx.MaxInserts * 2));

        foreach (var scene in sb.Scenes.OrderByDescending(s => s.Energy))
        {
            if (picks.Count >= settings.Ltx.MaxInserts) break;
            if (scene.Duration < clip + 1) continue;

            // Land just after the scene opens so the transition is not overlapped.
            double start = scene.Start + Math.Min(1.0, scene.Duration * 0.1);
            if (start + clip > sb.Duration) continue;
            if (picks.Any(p => Math.Abs(p.Item2 - start) < minGap)) continue;

            picks.Add((scene, start));
        }

        return picks.OrderBy(p => p.Item2).ToList();
    }

    LtxInsert MakeInsert(
        int index, double start, ProjectSettings settings, string clipFile,
        StoryScene scene, int seed)
    {
        // Deterministic per-insert blend choice, biased by scene energy: hot scenes
        // get additive/screen (they bloom), calmer ones get multiply/overlay.
        var rng = new Random(seed * 7919 + index);
        var pool = scene.Energy > 0.65
            ? new[] { "screen", "add", "difference", "xor" }
            : ["multiply", "overlay", "screen"];
        var blend = pool[rng.Next(pool.Length)];

        return new LtxInsert(
            Index: index,
            Start: start,
            Duration: settings.Ltx.ClipSeconds,
            ClipFile: Path.GetFileName(clipFile),
            Blend: blend,
            // Fade in and out so a clip never pops; peaks with the music.
            Opacity: "smoothstep(0,0.6,clipT)*smoothstep(0,0.6,1-clipT)*(0.55+0.35*rms)",
            Prompt: "",
            InitMode: settings.Ltx.InitMode);
    }

    static string BuildPrompt(
        SongText song, StoryScene scene, Storyboard sb, AudioAnalysis analysis, double t)
    {
        var section = analysis.Sections.FirstOrDefault(s => t >= s.Start && t < s.End);
        var lyric = section?.Lyrics.FirstOrDefault() ?? "";

        // Same three-layer composition Mp3ToVid uses: author directives, then the
        // storyboard's global look, then this beat's own colour.
        var style = SongText.ComposeStyle(
            song.Style,
            $"{sb.Palette} palette, abstract demoscene visual, {sb.Mood}",
            scene.Energy > 0.7 ? "harsh high contrast, intense" : "soft, restrained");

        var subject = string.IsNullOrWhiteSpace(lyric)
            ? "abstract flowing forms, geometric light structures"
            : lyric;

        return $"{subject}. {style}".Trim();
    }

    static int RoundTo32(double v) => Math.Max(32, (int)(Math.Round(v / 32.0) * 32));

    static string HashKey(string prompt, int w, int h, double seconds, int seed)
    {
        var raw = $"{prompt}|{w}x{h}|{seconds}|{seed}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))[..16];
    }

    static Dictionary<string, string> LoadCache(ProjectPaths paths)
    {
        if (!File.Exists(paths.LtxPromptsFile)) return [];
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(
                File.ReadAllText(paths.LtxPromptsFile)) ?? [];
        }
        catch (JsonException) { return []; }
    }

    static void SaveCache(ProjectPaths paths, Dictionary<string, string> cache) =>
        File.WriteAllText(paths.LtxPromptsFile,
            JsonSerializer.Serialize(cache, new JsonSerializerOptions { WriteIndented = true }));

    static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "...";
}
