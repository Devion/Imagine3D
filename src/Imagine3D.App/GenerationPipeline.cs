using System.Text.Json;
using Imagine3D.Audio;
using Imagine3D.Comfy;
using Imagine3D.Direct;
using Imagine3D.Lyrics;
using Imagine3D.Media;
using Imagine3D.Pipeline;
using Imagine3D.Projects;

namespace Imagine3D.App;

/// The chain the user sees on screen, in order. Every stage writes its output to
/// disk before the next begins, so a failed render can be retried without redoing
/// the analysis, and any stage's result can be inspected or hand-edited.
public sealed class GenerationPipeline(
    ProjectStore store,
    EffectRegistryProvider registry,
    Ffmpeg ffmpeg,
    Session session)
{
    public async Task<string> RunAsync(
        string projectName, PipelineOptions options,
        IProgress<StageProgress> progress, CancellationToken ct)
    {
        var paths = store.Open(projectName);
        var settings = store.Load(paths);

        // 1. Analyse -----------------------------------------------------------
        var analysis = await Task.Run(() =>
            LoadOrAnalyze(paths, settings, options.Force, progress), ct);

        // Re-render an edited storyboard verbatim: no intent, no director.
        if (options.UseExistingStoryboard)
        {
            if (!File.Exists(paths.StoryboardFile))
                throw new InvalidOperationException(
                    "No storyboard on disk to re-render. Generate one first.");

            var existing = JsonSerializer.Deserialize<Storyboard>(
                               File.ReadAllText(paths.StoryboardFile), Json.Options)
                           ?? throw new InvalidOperationException("storyboard.json could not be read.");

            progress.Report(new StageProgress(PipelineStage.Intent, 1.0, "Skipped - using the storyboard on disk"));
            progress.Report(new StageProgress(PipelineStage.Storyboard, 1.0,
                $"Reusing {existing.Scenes.Length} scenes from plan/storyboard.json"));
            progress.Report(new StageProgress(PipelineStage.Ltx, 1.0, "Skipped"));

            var channelOnly = session.Channel
                ?? throw new InvalidOperationException("The render page is not connected.");
            var reRendered = await new RenderService(ffmpeg)
                .RenderAsync(channelOnly, paths, settings, existing, progress, ct);
            progress.Report(new StageProgress(PipelineStage.Done, 1.0, reRendered));
            return reRendered;
        }

        // 2. Intent ------------------------------------------------------------
        Intent? intent = null;
        if (options.UseLlm)
        {
            progress.Report(new StageProgress(PipelineStage.Intent, 0.1, "Asking the LLM for a visual intent"));
            try
            {
                intent = await IntentPlanner.PlanAsync(paths, analysis, ct);
                progress.Report(new StageProgress(PipelineStage.Intent, 1.0,
                    $"\"{Trunc(intent.Mood, 60)}\" - palette {intent.Palette}"));
            }
            catch (Exception e)
            {
                // Intent is an enhancement, never a dependency. Losing it costs
                // some thematic nuance, not the video.
                progress.Report(new StageProgress(PipelineStage.Intent, 1.0,
                    $"Skipped ({Trunc(e.Message, 90)}) - using the deterministic director"));
            }
        }
        else
        {
            progress.Report(new StageProgress(PipelineStage.Intent, 1.0, "Skipped - deterministic director only"));
        }

        // 3. Storyboard --------------------------------------------------------
        progress.Report(new StageProgress(PipelineStage.Storyboard, 0.2, "Choosing scenes and effects"));
        var storyboard = new Director(registry.Current).Build(analysis, settings, intent);
        File.WriteAllText(paths.StoryboardFile, JsonSerializer.Serialize(storyboard, Json.Indented));
        progress.Report(new StageProgress(PipelineStage.Storyboard, 1.0,
            $"{storyboard.Scenes.Length} scenes, " +
            $"{storyboard.Scenes.Sum(s => s.Post.Length)} post effects, " +
            $"{storyboard.Texts.Length} text cues"));

        if (options.PlanOnly)
        {
            progress.Report(new StageProgress(PipelineStage.Ltx, 1.0, "Skipped"));
            progress.Report(new StageProgress(PipelineStage.Done, 1.0,
                $"Storyboard only - {storyboard.Scenes.Length} scenes planned, nothing rendered"));
            return paths.StoryboardFile;
        }

        // 4. LTX ---------------------------------------------------------------
        if (options.GenerateLtx && settings.Ltx.Enabled)
        {
            // "render" init mode asks the page for a frame of the demo at the insert
            // timestamp, so the LTX clip grows out of the scene it lands on.
            var ltx = new LtxStage(ffmpeg, AppPaths.WorkflowsDir,
                snapshot: (t, w, h, token) => SnapshotAsync(t, w, h, token));
            storyboard = await ltx.RunAsync(paths, settings, analysis, storyboard, progress, ct);
            File.WriteAllText(paths.StoryboardFile, JsonSerializer.Serialize(storyboard, Json.Indented));
        }
        else
        {
            progress.Report(new StageProgress(PipelineStage.Ltx, 1.0, "Skipped"));
        }

        // 5+6. Render and encode ----------------------------------------------
        var channel = session.Channel
            ?? throw new InvalidOperationException(
                "The render page is not connected. Reload the window and try again.");

        var output = await new RenderService(ffmpeg)
            .RenderAsync(channel, paths, settings, storyboard, progress, ct);

        progress.Report(new StageProgress(PipelineStage.Done, 1.0, output));
        return output;
    }

    /// Ask the page to draw one frame of the storyboard at time t and hand back a
    /// PNG. Used as the LTX init image.
    async Task<byte[]> SnapshotAsync(double t, int w, int h, CancellationToken ct)
    {
        var channel = session.Channel
            ?? throw new InvalidOperationException("The render page is not connected.");

        await channel.SendJsonAsync(new { cmd = "snapshot", t, width = w, height = h }, ct);
        return await channel.ReadBinaryAsync(TimeSpan.FromSeconds(120), ct: ct);
    }

    AudioAnalysis LoadOrAnalyze(
        ProjectPaths paths, ProjectSettings settings, bool force, IProgress<StageProgress> progress)
    {
        if (!force && File.Exists(paths.AnalysisFile))
        {
            try
            {
                var cached = JsonSerializer.Deserialize<AudioAnalysis>(
                    File.ReadAllText(paths.AnalysisFile), Json.Options);
                if (cached is not null)
                {
                    progress.Report(new StageProgress(PipelineStage.Analyze, 1.0,
                        $"Reusing analysis - {cached.Bpm:F1} BPM, {cached.Sections.Length} sections"));
                    return cached;
                }
            }
            catch (JsonException)
            {
                // Corrupt cache: fall through and recompute rather than fail.
            }
        }

        return Analyze(paths, settings, progress).Analysis;
    }

    public (AudioAnalysis Analysis, Waveform Waveform) Analyze(
        ProjectPaths paths, ProjectSettings settings, IProgress<StageProgress> progress)
    {
        var mp3 = paths.FindMp3()
            ?? throw new InvalidOperationException("This project has no MP3 yet - import one first.");
        var txt = paths.FindTxt();
        var lyrics = txt is not null ? File.ReadAllText(txt) : null;

        var heard = lyrics is null ? null : GetWordTimeline(paths, settings, mp3, lyrics, progress);

        var result = new AudioAnalyzer().Analyze(
            mp3, lyrics,
            new AudioAnalyzer.Options(settings.BpmOverride, settings.DownbeatOffsetOverride, heard),
            progress);

        paths.EnsureCreated();
        File.WriteAllText(paths.AnalysisFile, JsonSerializer.Serialize(result.Analysis, Json.Options));
        File.WriteAllText(paths.WaveformFile, JsonSerializer.Serialize(result.Waveform, Json.Options));
        return result;
    }

    /// Whisper's word timeline, cached on disk. Transcription is a 20-second GPU
    /// pass, so it must not repeat every time the analysis is re-run.
    WordStamp[]? GetWordTimeline(
        ProjectPaths paths, ProjectSettings settings, string mp3, string lyrics,
        IProgress<StageProgress> progress)
    {
        if (settings.LyricAlignment == "structural") return null;

        if (File.Exists(paths.WordsFile))
        {
            try
            {
                var cached = JsonSerializer.Deserialize<WordStamp[]>(
                    File.ReadAllText(paths.WordsFile), Json.Options);
                if (cached is { Length: > 0 })
                {
                    progress.Report(new StageProgress(PipelineStage.Analyze, 0.1,
                        $"Reusing vocal alignment - {cached.Length} words"));
                    return cached;
                }
            }
            catch (JsonException) { /* recompute */ }
        }

        if (!WhisperTranscriber.IsAvailable)
        {
            var message = "No Whisper-capable Python found - lyrics will be placed by section instead";
            if (settings.LyricAlignment == "whisper")
                throw new InvalidOperationException(message);
            progress.Report(new StageProgress(PipelineStage.Analyze, 0.1, message));
            return null;
        }

        try
        {
            progress.Report(new StageProgress(PipelineStage.Analyze, 0.1,
                $"Aligning lyrics to the vocal ({settings.WhisperModel})"));

            var song = SongText.Parse(lyrics);
            var words = new WhisperTranscriber(ffmpeg).TranscribeAsync(
                mp3, paths.CacheDir, settings.WhisperModel, song.Lyrics,
                // Centre-channel isolation measurably reduced the number of usable
                // anchors on real material, so the full mix is used.
                isolateVocals: false).GetAwaiter().GetResult();

            paths.EnsureCreated();
            File.WriteAllText(paths.WordsFile, JsonSerializer.Serialize(words, Json.Options));
            return words;
        }
        catch (Exception e)
        {
            if (settings.LyricAlignment == "whisper") throw;
            progress.Report(new StageProgress(PipelineStage.Analyze, 0.1,
                $"Vocal alignment failed ({Trunc(e.Message, 80)}) - placing lyrics by section"));
            return null;
        }
    }

    static string Trunc(string s, int n) =>
        string.IsNullOrEmpty(s) ? "" : s.Length <= n ? s : s[..n] + "...";
}
