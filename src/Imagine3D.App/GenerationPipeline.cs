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

        // 2+3. Intent and storyboard -------------------------------------------
        // The plan on disk is the plan on screen. Analysing writes one so the scenes
        // can be read and corrected before a minute of rendering is spent on them,
        // and this is what renders it: planning again here made that list a preview
        // of a video nobody was going to get - a new seed and the LLM's intent both
        // land before the director, so the effects came out different every time.
        //
        // Re-planning is a thing the user asks for - Redo storyboard, Reroll - or a
        // thing the plan itself forces by no longer describing this song at these
        // settings. Both go through the same director as before.
        var onDisk = LoadStoryboard(paths);
        var reason = options.PlanOnly ? "you asked for a new plan"
            : options.Force ? "the song was analysed again"
            : onDisk is null ? "there is no plan yet"
            : onDisk.StaleBecause(settings, analysis);

        Storyboard storyboard;
        if (reason is null)
        {
            progress.Report(new StageProgress(PipelineStage.Intent, 1.0,
                "Skipped - rendering the storyboard you already have"));
            progress.Report(new StageProgress(PipelineStage.Storyboard, 1.0,
                $"Using the {onDisk!.Scenes.Length} scenes below - seed {onDisk.Seed} " +
                "(press Redo storyboard for a different set)"));
            storyboard = onDisk;
        }
        else
        {
            var intent = await PlanIntentAsync(paths, analysis, options.UseLlm, progress, ct);

            progress.Report(new StageProgress(PipelineStage.Storyboard, 0.2,
                $"Choosing scenes and effects - {reason}"));
            storyboard = Plan(paths, settings, analysis, intent, progress);
        }

        // 4. LTX ---------------------------------------------------------------
        // Ahead of the plan-only exit on purpose. The director always returns an
        // empty Ltx list - inserts are attached here - so re-planning used to drop
        // every insert on the floor, and the next "Render this storyboard" then
        // produced a video with no clips in it at all. A re-plan has to place the
        // inserts, and generate any clip it does not already have, or it is not a
        // plan of the same video. A reused plan keeps the inserts it already has:
        // the picks fall out of the scene spans, so they come back identical and
        // the clips are all cache hits.
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

        if (options.PlanOnly)
        {
            var withLtx = storyboard.Ltx.Length > 0 ? $", {storyboard.Ltx.Length} LTX inserts" : "";
            progress.Report(new StageProgress(PipelineStage.Done, 1.0,
                $"Storyboard only - {storyboard.Scenes.Length} scenes{withLtx} planned, nothing rendered"));
            return paths.StoryboardFile;
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

    /// The LLM's read of the song, or null to leave the director to its own devices.
    ///
    /// Belongs to whoever is about to plan - the analyse step as much as a full run -
    /// because intent only reaches the video through the director. Asking for it after
    /// the plan the user is looking at was already made would either do nothing or
    /// silently replace that plan, and both were confusing.
    public async Task<Intent?> PlanIntentAsync(
        ProjectPaths paths, AudioAnalysis analysis, bool useLlm,
        IProgress<StageProgress> progress, CancellationToken ct)
    {
        if (!useLlm)
        {
            progress.Report(new StageProgress(PipelineStage.Intent, 1.0, "Skipped - deterministic director only"));
            return null;
        }

        progress.Report(new StageProgress(PipelineStage.Intent, 0.1, "Asking the LLM for a visual intent"));
        try
        {
            var intent = await IntentPlanner.PlanAsync(paths, analysis, ct);
            progress.Report(new StageProgress(PipelineStage.Intent, 1.0,
                $"\"{Trunc(intent.Mood, 60)}\" - palette {intent.Palette}"));
            return intent;
        }
        catch (Exception e)
        {
            // Intent is an enhancement, never a dependency. Losing it costs
            // some thematic nuance, not the video.
            progress.Report(new StageProgress(PipelineStage.Intent, 1.0,
                $"Skipped ({Trunc(e.Message, 90)}) - using the deterministic director"));
            return null;
        }
    }

    /// Run the director and write the plan to disk.
    ///
    /// Shared by the full pipeline and by the analyse step, which plans immediately so
    /// the scene list is on screen and editable before anything is rendered - it used
    /// to appear only once a whole video had finished encoding, which is far too late
    /// to be worth reading.
    public Storyboard Plan(
        ProjectPaths paths, ProjectSettings settings, AudioAnalysis analysis,
        Intent? intent, IProgress<StageProgress> progress)
    {
        // A fresh seed per plan, so consecutive songs are not planned from an
        // identical RNG stream. Saved before the director runs and echoed in the
        // stage line: the seed in project.json is always the one the storyboard
        // next to it was built with, which is what keeps a video reproducible.
        //
        // It belongs here rather than in the render run - rolling it there meant
        // the plan the user had just reviewed was rebuilt from a different stream
        // the moment they pressed Generate.
        if (settings.RandomSeedEachRun)
        {
            settings.Seed = Random.Shared.Next(1, 1_000_000);
            store.Save(paths, settings);
        }

        // Read fresh rather than cached: images are dropped into the folder between
        // runs, and the point of pressing Redo storyboard after adding some is that
        // the new ones are in the plan.
        var images = paths.ListImages();

        var storyboard = new Director(registry.Current)
            .Build(analysis, settings, intent, LoadStoryboard(paths), images);

        paths.EnsureCreated();
        File.WriteAllText(paths.StoryboardFile, JsonSerializer.Serialize(storyboard, Json.Indented));

        int held = storyboard.Scenes.Count(s => s.Locked);
        int placed = storyboard.Images?.Length ?? 0;
        progress.Report(new StageProgress(PipelineStage.Storyboard, 1.0,
            $"{storyboard.Scenes.Length} scenes, " +
            $"{storyboard.Scenes.Sum(s => s.Post.Length)} post effects, " +
            $"{storyboard.Texts.Length} text cues - seed {settings.Seed}" +
            (placed > 0
                ? $" - {placed} image cue{(placed == 1 ? "" : "s")} from " +
                  $"{storyboard.Images!.Select(i => i.File).Distinct(StringComparer.OrdinalIgnoreCase).Count()} " +
                  $"of your {images.Count}"
                : "") +
            (held > 0 ? $" - {held} kept from your edits" : "")));

        return storyboard;
    }

    /// The plan already on disk, or null. A corrupt one is not a reason to refuse to
    /// make a new one; it only costs whichever scenes had been pinned by hand.
    public static Storyboard? LoadStoryboard(ProjectPaths paths)
    {
        if (!File.Exists(paths.StoryboardFile)) return null;
        try
        {
            return JsonSerializer.Deserialize<Storyboard>(
                File.ReadAllText(paths.StoryboardFile), Json.Options);
        }
        catch (JsonException) { return null; }
    }

    /// Ask the page to draw one frame of the storyboard at time t and hand back a
    /// PNG. Used as the LTX init image.
    async Task<byte[]> SnapshotAsync(double t, int w, int h, CancellationToken ct)
    {
        var channel = session.Channel
            ?? throw new InvalidOperationException("The render page is not connected.");

        // A snapshot that timed out earlier can still land afterwards; that image
        // is not the answer to this request.
        channel.Drain();

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
                // An analysis written before the fine spectrum existed is missing
                // the bands half the effect library now modulates on, and nothing
                // downstream can reconstruct them from what it does carry. Treat it
                // as stale and recompute rather than serving effects a flat zero.
                if (cached is { HasFineBands: true })
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
