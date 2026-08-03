using NAudio.Wave;

namespace Imagine3D.Audio;

public sealed record DecodedAudio(float[] Mono, int SampleRate, double Duration);

public static class Decoder
{
    /// Decode an MP3 (or anything NAudio opens) to mono float PCM.
    /// Analysis runs at a fixed 22.05 kHz: everything we detect - onsets, tempo,
    /// structure - lives well below 11 kHz, and halving the rate halves the FFT
    /// cost across the whole chain for no loss in what we actually measure.
    public static DecodedAudio Load(string path, int targetRate = 22050)
    {
        using var reader = new AudioFileReader(path);
        int srcRate = reader.WaveFormat.SampleRate;
        int channels = reader.WaveFormat.Channels;

        var interleaved = new List<float>(capacity: 1 << 20);
        var buf = new float[16384];
        int read;
        while ((read = reader.Read(buf, 0, buf.Length)) > 0)
            interleaved.AddRange(buf.AsSpan(0, read).ToArray());

        // Downmix to mono.
        int frames = interleaved.Count / Math.Max(1, channels);
        var mono = new float[frames];
        for (int i = 0; i < frames; i++)
        {
            float sum = 0;
            for (int c = 0; c < channels; c++) sum += interleaved[i * channels + c];
            mono[i] = sum / channels;
        }

        var (samples, rate) = srcRate == targetRate
            ? (mono, srcRate)
            : (Resample(mono, srcRate, targetRate), targetRate);

        return new DecodedAudio(samples, rate, samples.Length / (double)rate);
    }

    /// Linear resampling. The signal is already low-passed by being music, and
    /// onset/tempo detection is insensitive to the tiny aliasing this leaves.
    static float[] Resample(float[] src, int from, int to)
    {
        if (src.Length == 0) return src;
        double ratio = (double)from / to;
        int n = (int)(src.Length / ratio);
        var dst = new float[n];
        for (int i = 0; i < n; i++)
        {
            double x = i * ratio;
            int i0 = (int)x;
            int i1 = Math.Min(i0 + 1, src.Length - 1);
            float frac = (float)(x - i0);
            dst[i] = src[i0] * (1 - frac) + src[i1] * frac;
        }
        return dst;
    }

    /// Peak envelope for the UI waveform, min/max per bucket so transients survive.
    public static (float[] Min, float[] Max) Peaks(float[] mono, int buckets)
    {
        buckets = Math.Max(1, buckets);
        var lo = new float[buckets];
        var hi = new float[buckets];
        int per = Math.Max(1, mono.Length / buckets);
        for (int b = 0; b < buckets; b++)
        {
            int s = b * per, e = Math.Min(mono.Length, s + per);
            float mn = 0, mx = 0;
            for (int i = s; i < e; i++)
            {
                if (mono[i] < mn) mn = mono[i];
                if (mono[i] > mx) mx = mono[i];
            }
            lo[b] = mn;
            hi[b] = mx;
        }
        return (lo, hi);
    }
}
