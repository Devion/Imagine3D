namespace Imagine3D.Audio;

/// The six-band "VU" the effects actually react to. Each band gets a fast-attack /
/// slow-release follower so a shader driven by `bass` punches on the hit and eases
/// out, rather than flickering at the analysis frame rate.
public static class BandEnergy
{
    public static readonly string[] Names = ["sub", "bass", "lowMid", "mid", "high", "air"];

    static readonly (double Lo, double Hi)[] Ranges =
    [
        (20, 60), (60, 150), (150, 400), (400, 1500), (1500, 5000), (5000, 16000),
    ];

    /// How many bands the fine spectrum carries. Twelve over the analysable range
    /// works out at about three quarters of an octave each.
    public const int FineCount = 12;

    /// Top of the fine spectrum. Decoder fixes analysis at 22.05 kHz, so Nyquist
    /// is 11.025 kHz and the last stretch below it is inside the resampler's
    /// rolloff - a band placed up there measures the resampler, not the music.
    /// The coarse `air` band still declares 16 kHz and is clamped, which is
    /// harmless when it is one wide band but would waste two of twelve here.
    const double FineLoHz = 20, FineHiHz = 10500;

    /// The twelve band edges, 13 values, geometrically spaced.
    ///
    /// Log rather than linear because pitch is. Splitting 20 Hz - 10.5 kHz evenly
    /// would put nine of the twelve bands above 2.6 kHz, where music has little
    /// but cymbals and sibilance, and crush every bass note, every vocal
    /// fundamental and most of the harmonic content of the arrangement into the
    /// first band. Equal ratios give equal musical intervals, so each band covers
    /// a comparable amount of what is actually being played.
    public static readonly double[] FineEdges = BuildFineEdges();

    static double[] BuildFineEdges()
    {
        var e = new double[FineCount + 1];
        double ratio = Math.Pow(FineHiHz / FineLoHz, 1.0 / FineCount);
        e[0] = FineLoHz;
        for (int i = 1; i <= FineCount; i++) e[i] = e[i - 1] * ratio;
        return e;
    }

    public static float[][] Compute(Spectrogram spec, double attackMs = 8, double releaseMs = 180) =>
        Compute(spec, Ranges, attackMs, releaseMs);

    /// The fine spectrum, on a faster release than the coarse six.
    ///
    /// A coarse band covers a whole register, so something in it is nearly always
    /// sounding and a long release reads as the register's level. A fine band
    /// tracks closer to one instrument, and holding it for 180 ms smears a hi-hat
    /// pattern into a plateau - which is exactly the detail these bands exist to
    /// expose.
    public static float[][] ComputeFine(Spectrogram spec, double attackMs = 6, double releaseMs = 110)
    {
        var ranges = new (double Lo, double Hi)[FineCount];
        for (int i = 0; i < FineCount; i++) ranges[i] = (FineEdges[i], FineEdges[i + 1]);
        return Compute(spec, ranges, attackMs, releaseMs);
    }

    static float[][] Compute(
        Spectrogram spec, (double Lo, double Hi)[] ranges, double attackMs, double releaseMs)
    {
        int n = spec.Frames;
        var bands = new float[ranges.Length][];
        double dtMs = 1000.0 / spec.FrameRate;

        for (int r = 0; r < ranges.Length; r++)
        {
            int lo = spec.HzToBin(ranges[r].Lo);
            int hi = spec.HzToBin(Math.Min(ranges[r].Hi, spec.SampleRate / 2.0 - 1));
            var raw = new float[n];
            for (int f = 0; f < n; f++)
            {
                float sum = 0;
                var mag = spec.Mag[f];
                for (int b = lo; b <= hi; b++) sum += mag[b];
                raw[f] = sum / Math.Max(1, hi - lo + 1);
            }

            bands[r] = Follow(NormalizeDynamicRange(raw), dtMs, attackMs, releaseMs);
        }

        return bands;
    }

    public static float[] Rms(float[] mono, Spectrogram spec)
    {
        int n = spec.Frames;
        var rms = new float[n];
        for (int f = 0; f < n; f++)
        {
            int s = f * spec.Hop;
            int e = Math.Min(mono.Length, s + spec.FftSize);
            double acc = 0;
            for (int i = s; i < e; i++) acc += mono[i] * (double)mono[i];
            rms[f] = (float)Math.Sqrt(acc / Math.Max(1, e - s));
        }
        return Follow(NormalizeDynamicRange(rms), 1000.0 / spec.FrameRate, 20, 250);
    }

    /// Map the signal onto 0..1 in the *decibel* domain, stretching the 5th-95th
    /// percentile across the full range.
    ///
    /// Linear percentile scaling produced bands that sat at 0.75-0.86 for the whole
    /// song - technically correct, but useless as a modulation source because a
    /// shader driven by it barely moves. Music is roughly log-perceived, so dB is
    /// the domain where "how loud is the bass right now" has usable contrast.
    public static float[] NormalizeDynamicRange(float[] x, double loPct = 0.05, double hiPct = 0.95)
    {
        if (x.Length == 0) return x;

        var db = new float[x.Length];
        for (int i = 0; i < x.Length; i++) db[i] = 20f * MathF.Log10(x[i] + 1e-7f);

        var sorted = (float[])db.Clone();
        Array.Sort(sorted);
        float lo = sorted[Math.Clamp((int)(sorted.Length * loPct), 0, sorted.Length - 1)];
        float hi = sorted[Math.Clamp((int)(sorted.Length * hiPct), 0, sorted.Length - 1)];

        // A near-silent or perfectly flat band would divide by ~zero and explode.
        if (hi - lo < 6f) hi = lo + 6f;

        var outp = new float[x.Length];
        for (int i = 0; i < x.Length; i++) outp[i] = Math.Clamp((db[i] - lo) / (hi - lo), 0f, 1f);
        return outp;
    }

    /// Scale so the given percentile maps to 1.0, then clamp. Using a percentile
    /// rather than the max stops one clipped transient from crushing the envelope.
    public static float[] NormalizePercentile(float[] x, double p)
    {
        if (x.Length == 0) return x;
        var sorted = (float[])x.Clone();
        Array.Sort(sorted);
        float refv = sorted[Math.Clamp((int)(sorted.Length * p), 0, sorted.Length - 1)];
        if (refv <= 1e-9f) return new float[x.Length];
        var outp = new float[x.Length];
        for (int i = 0; i < x.Length; i++) outp[i] = Math.Clamp(x[i] / refv, 0f, 1f);
        return outp;
    }

    static float[] Follow(float[] x, double dtMs, double attackMs, double releaseMs)
    {
        var outp = new float[x.Length];
        float a = (float)(1 - Math.Exp(-dtMs / Math.Max(1e-3, attackMs)));
        float r = (float)(1 - Math.Exp(-dtMs / Math.Max(1e-3, releaseMs)));
        float y = 0;
        for (int i = 0; i < x.Length; i++)
        {
            float coeff = x[i] > y ? a : r;
            y += coeff * (x[i] - y);
            outp[i] = y;
        }
        return outp;
    }
}
