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

    public static float[][] Compute(Spectrogram spec, double attackMs = 8, double releaseMs = 180)
    {
        int n = spec.Frames;
        var bands = new float[Ranges.Length][];
        double dtMs = 1000.0 / spec.FrameRate;

        for (int r = 0; r < Ranges.Length; r++)
        {
            int lo = spec.HzToBin(Ranges[r].Lo);
            int hi = spec.HzToBin(Math.Min(Ranges[r].Hi, spec.SampleRate / 2.0 - 1));
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
