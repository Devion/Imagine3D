namespace Imagine3D.Audio;

public sealed record SectionBoundary(double Time, double Strength);

/// Structural segmentation: MFCC features -> self-similarity matrix -> Foote
/// checkerboard novelty -> boundaries -> cluster repeated material into labels.
/// These boundaries are where the director is allowed to change scene.
public static class StructureAnalyzer
{
    const int MelBands = 24;
    const int Coeffs = 13;

    /// Feature frame rate. ~4 Hz keeps the similarity matrix small (a 5 min song is
    /// 1200x1200) while still resolving section edges to well under a second.
    const double FeatureRate = 4.0;

    public static (float[][] Features, double Rate) Mfcc(Spectrogram spec)
    {
        var filters = MelFilterbank(spec, MelBands);
        int stride = Math.Max(1, (int)Math.Round(spec.FrameRate / FeatureRate));
        int n = spec.Frames / stride;
        var feats = new float[Math.Max(1, n)][];

        var energies = new float[MelBands];
        for (int i = 0; i < feats.Length; i++)
        {
            Array.Clear(energies);
            // Average the spectrogram frames inside this feature frame.
            int s = i * stride, e = Math.Min(spec.Frames, s + stride);
            for (int f = s; f < e; f++)
            {
                var mag = spec.Mag[f];
                for (int m = 0; m < MelBands; m++)
                {
                    var (lo, hi, peak) = filters[m];
                    float acc = 0;
                    for (int b = lo; b <= hi; b++)
                    {
                        float w = b <= peak
                            ? (peak == lo ? 1f : (b - lo) / (float)(peak - lo))
                            : (hi == peak ? 1f : (hi - b) / (float)(hi - peak));
                        acc += mag[b] * w;
                    }
                    energies[m] += acc;
                }
            }
            for (int m = 0; m < MelBands; m++)
                energies[m] = MathF.Log(1e-6f + energies[m] / Math.Max(1, e - s));

            // DCT-II, dropping c0 (overall loudness) so sections are compared on
            // timbre rather than on how loud they happen to be.
            var c = new float[Coeffs];
            for (int k = 1; k <= Coeffs; k++)
            {
                double sum = 0;
                for (int m = 0; m < MelBands; m++)
                    sum += energies[m] * Math.Cos(Math.PI * k * (m + 0.5) / MelBands);
                c[k - 1] = (float)sum;
            }
            feats[i] = Normalize(c);
        }

        return (feats, spec.FrameRate / stride);
    }

    static (int Lo, int Hi, int Peak)[] MelFilterbank(Spectrogram spec, int bands)
    {
        static double ToMel(double hz) => 2595 * Math.Log10(1 + hz / 700);
        static double FromMel(double mel) => 700 * (Math.Pow(10, mel / 2595) - 1);

        double loHz = 40, hiHz = Math.Min(8000, spec.SampleRate / 2.0 - 1);
        double loMel = ToMel(loHz), hiMel = ToMel(hiHz);

        var points = new int[bands + 2];
        for (int i = 0; i < points.Length; i++)
            points[i] = spec.HzToBin(FromMel(loMel + (hiMel - loMel) * i / (bands + 1)));

        var filters = new (int, int, int)[bands];
        for (int m = 0; m < bands; m++)
        {
            int lo = points[m], peak = points[m + 1], hi = points[m + 2];
            // Degenerate filters happen at low frequencies where bins are coarse.
            if (peak <= lo) peak = lo + 1;
            if (hi <= peak) hi = peak + 1;
            filters[m] = (lo, Math.Min(hi, spec.Bins - 1), Math.Min(peak, spec.Bins - 1));
        }
        return filters;
    }

    static float[] Normalize(float[] v)
    {
        double norm = Math.Sqrt(v.Sum(x => (double)x * x));
        if (norm < 1e-9) return v;
        var outp = new float[v.Length];
        for (int i = 0; i < v.Length; i++) outp[i] = (float)(v[i] / norm);
        return outp;
    }

    /// Foote novelty: correlate a checkerboard kernel down the diagonal of the
    /// self-similarity matrix. It peaks where the music stops resembling itself.
    public static float[] Novelty(float[][] feats, int kernelSize = 32)
    {
        int n = feats.Length;
        var novelty = new float[n];
        if (n < kernelSize * 2) return novelty;

        int half = kernelSize / 2;
        var kernel = new float[kernelSize, kernelSize];
        for (int i = 0; i < kernelSize; i++)
        for (int j = 0; j < kernelSize; j++)
        {
            // Gaussian-tapered so distant frames don't dominate the response.
            double di = (i - half + 0.5) / half, dj = (j - half + 0.5) / half;
            double g = Math.Exp(-4 * (di * di + dj * dj));
            int sign = (i < half) == (j < half) ? 1 : -1;
            kernel[i, j] = (float)(sign * g);
        }

        for (int c = half; c < n - half; c++)
        {
            float acc = 0;
            for (int i = 0; i < kernelSize; i++)
            for (int j = 0; j < kernelSize; j++)
                acc += kernel[i, j] * Similarity(feats[c - half + i], feats[c - half + j]);
            novelty[c] = Math.Max(0, acc);
        }

        return OnsetEnvelope.Normalize(novelty);
    }

    static float Similarity(float[] a, float[] b)
    {
        float dot = 0;
        for (int i = 0; i < a.Length; i++) dot += a[i] * b[i];
        return dot; // features are unit-norm, so this is cosine similarity
    }

    public static List<SectionBoundary> PickBoundaries(
        float[] novelty, double rate, double minSectionSeconds = 8)
    {
        var result = new List<SectionBoundary>();
        int minGap = Math.Max(1, (int)(minSectionSeconds * rate));
        float mean = novelty.Length > 0 ? novelty.Average() : 0;
        float thresh = Math.Max(0.12f, mean * 1.4f);

        var peaks = new List<(int Idx, float Val)>();
        for (int i = 1; i < novelty.Length - 1; i++)
            if (novelty[i] >= thresh && novelty[i] >= novelty[i - 1] && novelty[i] > novelty[i + 1])
                peaks.Add((i, novelty[i]));

        // Strongest first, then greedily drop anything too close to a kept peak -
        // guarantees the minimum section length without losing the best boundaries.
        foreach (var (idx, val) in peaks.OrderByDescending(p => p.Val))
        {
            if (result.Any(b => Math.Abs(b.Time * rate - idx) < minGap)) continue;
            result.Add(new SectionBoundary(idx / rate, val));
        }

        return result.OrderBy(b => b.Time).ToList();
    }

    /// Group sections whose average timbre matches into the same label, so a repeat
    /// of the chorus can be recognised (and given a matching visual treatment).
    public static string[] LabelSections(float[][] feats, double rate, double[] starts, double[] ends)
    {
        var centroids = new List<float[]>();
        var labels = new string[starts.Length];

        for (int i = 0; i < starts.Length; i++)
        {
            int s = Math.Clamp((int)(starts[i] * rate), 0, Math.Max(0, feats.Length - 1));
            int e = Math.Clamp((int)(ends[i] * rate), s + 1, feats.Length);
            var mean = new float[feats[0].Length];
            for (int f = s; f < e; f++)
                for (int k = 0; k < mean.Length; k++) mean[k] += feats[f][k];
            for (int k = 0; k < mean.Length; k++) mean[k] /= Math.Max(1, e - s);
            mean = Normalize(mean);

            int match = -1;
            for (int c = 0; c < centroids.Count; c++)
                if (Similarity(centroids[c], mean) > 0.82f) { match = c; break; }

            if (match < 0) { centroids.Add(mean); match = centroids.Count - 1; }
            labels[i] = ((char)('A' + Math.Min(match, 25))).ToString();
        }

        return labels;
    }
}
