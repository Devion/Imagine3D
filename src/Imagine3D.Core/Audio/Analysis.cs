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
    double LyricCoverage = 0)
{
    /// True when the beat grid is trustworthy enough to hard-sync cuts to.
    /// Below this the director falls back to section boundaries and the RMS
    /// envelope, which is the honest behaviour on rubato material.
    public bool BeatGridReliable => BpmPinned || BpmConfidence >= 0.4;
}

public sealed record Waveform(int Buckets, double Duration, float[] Min, float[] Max);
