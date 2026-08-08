namespace Imagine3D.Audio;

/// A structural section of the song. `Energy` is 0..1 and is what the director
/// uses to decide how hard an effect should hit.
public sealed record Section(
    int Index,
    double Start,
    double End,
    string Label,
    double Energy,
    double BoundaryStrength,
    string[] Markers,
    string[] Lyrics)
{
    public double Duration => End - Start;
}

public sealed record LyricLine(double Start, double End, string Text, bool IsMarker);

/// Everything the renderer and the director need to know about the song.
/// Serialised to analysis/analysis.json and shipped verbatim to the browser.
public sealed record AudioAnalysis(
    double Duration,
    int SampleRate,
    double FrameRate,
    double Bpm,
    double BpmConfidence,
    double BpmAlternate,
    bool BpmPinned,
    double[] Beats,
    double[] Downbeats,
    double[] Onsets,
    Section[] Sections,
    LyricLine[] Lyrics,
    string[] BandNames,
    float[] Rms,
    float[][] Bands,
    float[] Onset,
    /// "whisper" when lyric times came from forced alignment against the audio,
    /// "structural" when they were distributed across detected sections.
    string LyricSource = "structural",
    /// Fraction of lyric lines that got a real audio anchor. 0 for structural.
    double LyricCoverage = 0,
    /// The twelve-band spectrum, [band][frame]. `Bands` above stays the coarse six
    /// so that everything already written against `bass` keeps measuring what it
    /// always did; this is the finer read the same STFT can support, for effects
    /// that want to tell a kick from a bass note or a hi-hat from a vocal.
    /// Null on an analysis cached before fine bands existed.
    float[][]? FineBands = null,
    /// The 13 edges of those bands in Hz, so a shader can say what it is looking at.
    double[]? FineBandHz = null)
{
    /// True when the beat grid is trustworthy enough to hard-sync cuts to.
    /// Below this the director falls back to section boundaries and the RMS
    /// envelope, which is the honest behaviour on rubato material.
    public bool BeatGridReliable => BpmPinned || BpmConfidence >= 0.4;

    /// False for an analysis.json written before the fine spectrum was added.
    /// The pipeline re-analyses rather than serving one, so effects can rely on it.
    public bool HasFineBands => FineBands is { Length: BandEnergy.FineCount };
}

public sealed record Waveform(int Buckets, double Duration, float[] Min, float[] Max);
