namespace Imagine3D.Audio;

/// Spectral-flux onset detection: how much energy *appeared* between consecutive
/// frames. Log compression before differencing keeps a quiet hi-hat as visible as
/// a loud kick, which matters on dynamic material.
public static class OnsetEnvelope
{
    public static float[] Compute(Spectrogram spec)
    {
        int n = spec.Frames;
        var flux = new float[n];

        // Ignore the very bottom bins (rumble/DC) - they smear onset timing.
        int lo = spec.HzToBin(30);
        int hi = spec.HzToBin(Math.Min(11000, spec.SampleRate / 2.0 - 1));

        var prev = new float[spec.Bins];
        for (int f = 0; f < n; f++)
        {
            var mag = spec.Mag[f];
            float sum = 0;
            for (int b = lo; b <= hi; b++)
            {
                float cur = MathF.Log(1f + 1000f * mag[b]);
                float d = cur - prev[b];
                if (d > 0) sum += d;   // half-wave rectify: only rising energy is an onset
                prev[b] = cur;
            }
            flux[f] = sum;
        }

        return Normalize(SubtractLocalMean(flux, window: 16));
    }

    /// Removes the slow loudness trend so a quiet intro's onsets score comparably
    /// to a loud chorus's. Without this the beat tracker ignores soft passages.
    static float[] SubtractLocalMean(float[] x, int window)
    {
        var outp = new float[x.Length];
        double run = 0;
        var q = new Queue<float>();
        for (int i = 0; i < x.Length; i++)
        {
            q.Enqueue(x[i]);
            run += x[i];
            if (q.Count > window * 2 + 1) run -= q.Dequeue();
            float mean = (float)(run / q.Count);
            outp[i] = Math.Max(0, x[i] - mean);
        }
        return outp;
    }

    public static float[] Normalize(float[] x)
    {
        float max = 0;
        foreach (var v in x) if (v > max) max = v;
        if (max <= 0) return x;
        var outp = new float[x.Length];
        for (int i = 0; i < x.Length; i++) outp[i] = x[i] / max;
        return outp;
    }

    /// Discrete onset times (seconds) - used for accent-driven effect triggers that
    /// should fire on hits the beat grid doesn't cover.
    public static double[] PickPeaks(
        float[] env, double frameRate, double timeOffset = 0, double minGapSeconds = 0.05)
    {
        var times = new List<double>();
        int minGap = Math.Max(1, (int)(minGapSeconds * frameRate));
        float mean = env.Length > 0 ? env.Average() : 0;
        float thresh = mean * 1.5f;
        int last = -minGap;
        for (int i = 1; i < env.Length - 1; i++)
        {
            if (env[i] < thresh) continue;
            if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
            if (i - last < minGap) continue;
            times.Add(Math.Max(0, i / frameRate + timeOffset));
            last = i;
        }
        return times.ToArray();
    }
}
