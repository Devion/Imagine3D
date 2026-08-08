using Imagine3D.Lyrics;
using Imagine3D.Pipeline;

namespace Imagine3D.Audio;

/// Runs the whole analysis chain. One decode, one STFT, everything else derived.
public sealed class AudioAnalyzer
{
    public sealed record Options(
        double? BpmOverride,
        double? DownbeatOffsetOverride,
        /// Whisper word timeline, when forced alignment ran. Null falls back to
        /// distributing lyrics across the detected sections.
        WordStamp[]? HeardWords = null);

    public (AudioAnalysis Analysis, Waveform Waveform) Analyze(
        string mp3Path, string? lyricsText, Options opts, IProgress<StageProgress>? progress = null)
    {
        void Report(double f, string msg) =>
            progress?.Report(new StageProgress(PipelineStage.Analyze, f, msg));

        Report(0.05, "Decoding audio");
        var audio = Decoder.Load(mp3Path);
        if (audio.Mono.Length == 0)
            throw new InvalidOperationException($"No audio decoded from {Path.GetFileName(mp3Path)}");

        Report(0.20, "Computing spectrogram");
        var spec = new Spectrogram(audio.Mono, audio.SampleRate);

        Report(0.40, "Detecting onsets");
        var onsetEnv = OnsetEnvelope.Compute(spec);
        double tOff = spec.EventTimeOffset;
        var onsets = OnsetEnvelope.PickPeaks(onsetEnv, spec.FrameRate, tOff);

        Report(0.50, "Estimating tempo");
        var tempo = TempoEstimator.Estimate(onsetEnv, spec.FrameRate);
        bool pinned = opts.BpmOverride is > 0;
        double bpm = pinned ? opts.BpmOverride!.Value : tempo.Bpm;

        Report(0.60, $"Tracking beats at {bpm:F1} BPM");
        double[] beats;
        if (pinned)
        {
            // A pinned BPM means the user is telling us the grid; honour it exactly
            // rather than letting the tracker wander off it.
            double offset = opts.DownbeatOffsetOverride ?? FirstStrongOnset(onsetEnv, spec.FrameRate);
            beats = BeatTracker.Grid(bpm, audio.Duration, offset);
        }
        else
        {
            beats = BeatTracker.Track(onsetEnv, spec.FrameRate, bpm, tOff);
            if (beats.Length < 4)
                beats = BeatTracker.Grid(bpm, audio.Duration, FirstStrongOnset(onsetEnv, spec.FrameRate));
        }

        // Confidence is judged on the grid we actually produced, not just on how
        // peaky the autocorrelation was. A prominent ACF peak that still yields
        // ragged beat spacing is not a grid worth hard-syncing cuts to.
        double confidence = pinned ? 1.0 : CombineConfidence(tempo.Confidence, beats);

        int phase = opts.DownbeatOffsetOverride is not null && pinned
            ? 0
            : BeatTracker.FindDownbeatPhase(beats, spec);
        var downbeats = beats.Where((_, i) => (i - phase) % 4 == 0 && i >= phase).ToArray();

        Report(0.70, "Measuring levels");
        var rms = BandEnergy.Rms(audio.Mono, spec);
        var bands = BandEnergy.Compute(spec);
        var fineBands = BandEnergy.ComputeFine(spec);

        Report(0.80, "Finding structure");
        var (feats, featRate) = StructureAnalyzer.Mfcc(spec);
        var novelty = StructureAnalyzer.Novelty(feats);
        var boundaries = StructureAnalyzer.PickBoundaries(novelty, featRate);

        var sections = BuildSections(boundaries, downbeats, audio.Duration, rms, spec.FrameRate, feats, featRate);

        Report(0.92, "Mapping lyrics");
        var song = SongText.Parse(lyricsText);

        LyricLine[] lyricLines;
        string lyricSource = "structural";
        double lyricCoverage = 0;

        if (opts.HeardWords is { Length: > 0 })
        {
            var (forced, coverage) = LyricAligner.AlignForced(song, opts.HeardWords, audio.Duration);
            if (forced.Length > 0)
            {
                lyricLines = forced;
                lyricSource = "whisper";
                lyricCoverage = coverage;
                Report(0.94, $"Lyrics aligned to the vocal - {coverage:P0} of lines anchored");
            }
            else lyricLines = LyricAligner.Align(song, sections);
        }
        else lyricLines = LyricAligner.Align(song, sections);

        sections = LyricAligner.AttachToSections(sections, lyricLines);

        Report(0.97, "Building waveform");
        var (mn, mx) = Decoder.Peaks(audio.Mono, buckets: 2000);

        var analysis = new AudioAnalysis(
            audio.Duration, audio.SampleRate, spec.FrameRate,
            bpm, confidence, tempo.Alternate, pinned,
            beats, downbeats, onsets, sections, lyricLines,
            BandEnergy.Names, rms, bands, onsetEnv, lyricSource, lyricCoverage,
            fineBands, BandEnergy.FineEdges);

        Report(1.0,
            $"{bpm:F1} BPM (confidence {analysis.BpmConfidence:P0}) - " +
            $"{sections.Length} sections, {beats.Length} beats");

        return (analysis, new Waveform(mn.Length, audio.Duration, mn, mx));
    }

    /// Geometric mean of "was the tempo peak prominent" and "is the resulting grid
    /// evenly spaced". Both must hold - the geometric mean means either one being
    /// poor drags the score down, which is the conservative behaviour we want.
    static double CombineConfidence(double acfConfidence, double[] beats)
    {
        if (beats.Length < 4) return 0;

        var gaps = beats.Zip(beats.Skip(1), (a, b) => b - a).ToArray();
        double mean = gaps.Average();
        if (mean <= 0) return 0;
        double sd = Math.Sqrt(gaps.Sum(g => (g - mean) * (g - mean)) / gaps.Length);

        // Coefficient of variation: below 3% is machine-tight, above 15% is rubato.
        double cv = sd / mean;
        double regularity = Math.Clamp(1 - (cv - 0.03) / 0.12, 0, 1);

        return Math.Sqrt(Math.Clamp(acfConfidence, 0, 1) * regularity);
    }

    static double FirstStrongOnset(float[] env, double frameRate)
    {
        for (int i = 0; i < env.Length; i++) if (env[i] > 0.5f) return i / frameRate;
        return 0;
    }

    static Section[] BuildSections(
        List<SectionBoundary> boundaries, double[] downbeats, double duration,
        float[] rms, double rmsRate, float[][] feats, double featRate)
    {
        // Snap every boundary to the nearest downbeat so scene changes land on a
        // bar line rather than a fraction of a beat early.
        var times = new List<(double T, double S)> { (0, 1.0) };
        foreach (var b in boundaries)
        {
            double t = Snap(b.Time, downbeats, tolerance: 1.0);
            if (t > 2 && t < duration - 2 && times.All(x => Math.Abs(x.T - t) > 4))
                times.Add((t, b.Strength));
        }
        times.Sort((a, b) => a.T.CompareTo(b.T));

        var starts = times.Select(t => t.T).ToArray();
        var ends = starts.Skip(1).Append(duration).ToArray();
        var labels = feats.Length > 0
            ? StructureAnalyzer.LabelSections(feats, featRate, starts, ends)
            : starts.Select(_ => "A").ToArray();

        var sections = new Section[starts.Length];
        for (int i = 0; i < starts.Length; i++)
        {
            int s = Math.Clamp((int)(starts[i] * rmsRate), 0, Math.Max(0, rms.Length - 1));
            int e = Math.Clamp((int)(ends[i] * rmsRate), s + 1, rms.Length);
            double energy = 0;
            for (int f = s; f < e; f++) energy += rms[f];
            energy /= Math.Max(1, e - s);

            sections[i] = new Section(
                i, starts[i], ends[i], labels[i],
                Math.Clamp(energy, 0, 1), times[i].S, [], []);
        }

        return sections;
    }

    static double Snap(double t, double[] grid, double tolerance)
    {
        if (grid.Length == 0) return t;
        double best = grid[0];
        foreach (var g in grid) if (Math.Abs(g - t) < Math.Abs(best - t)) best = g;
        return Math.Abs(best - t) <= tolerance ? best : t;
    }
}
