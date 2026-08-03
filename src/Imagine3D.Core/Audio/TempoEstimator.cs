namespace Imagine3D.Audio;

public sealed record TempoEstimate(double Bpm, double Confidence, double Alternate);

/// Tempo from the autocorrelation of the onset envelope, with a log-normal prior
/// so the classic half/double-time ambiguity resolves toward a musical range.
public static class TempoEstimator
{
    const double MinBpm = 60, MaxBpm = 200, PriorCenter = 120, PriorWidth = 0.9;

    public static TempoEstimate Estimate(float[] onset, double frameRate)
    {
        int minLag = (int)(60.0 / MaxBpm * frameRate);
        int maxLag = (int)(60.0 / MinBpm * frameRate);
        maxLag = Math.Min(maxLag, onset.Length / 2);
        if (maxLag <= minLag || onset.Length < 8)
            return new TempoEstimate(PriorCenter, 0, PriorCenter * 2);

        var score = new double[maxLag + 1];
        for (int lag = minLag; lag <= maxLag; lag++)
        {
            double acc = 0;
            for (int i = lag; i < onset.Length; i++) acc += onset[i] * (double)onset[i - lag];
            acc /= onset.Length - lag;

            // Weight toward human-plausible tempi; without this, autocorrelation
            // routinely locks onto the bar rather than the beat.
            double bpm = 60.0 * frameRate / lag;
            double w = Math.Exp(-0.5 * Math.Pow(Math.Log(bpm / PriorCenter) / PriorWidth, 2));
            score[lag] = acc * w;
        }

        int best = minLag;
        for (int lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[best]) best = lag;

        double mean = 0;
        int count = 0;
        for (int lag = minLag; lag <= maxLag; lag++) { mean += score[lag]; count++; }
        mean = count > 0 ? mean / count : 0;

        // Peak-to-average ratio, squashed to 0..1. Divided by 6 rather than 3 so
        // real music doesn't saturate at 1.0 the moment it has any pulse at all -
        // this number has to stay able to say "I am not sure".
        double conf = mean > 0 ? Math.Clamp((score[best] / mean - 1.0) / 6.0, 0, 1) : 0;

        double bestBpm = 60.0 * frameRate / best;

        // Best peak that is not a near-multiple of the winner - the runner-up the
        // user is most likely to want when the pick is wrong.
        double alt = bestBpm * 2 <= MaxBpm ? bestBpm * 2 : bestBpm / 2;
        double altScore = 0;
        for (int lag = minLag; lag <= maxLag; lag++)
        {
            double bpm = 60.0 * frameRate / lag;
            double ratio = bpm / bestBpm;
            if (Math.Abs(ratio - 1) < 0.12) continue;
            if (score[lag] > altScore) { altScore = score[lag]; alt = bpm; }
        }

        return new TempoEstimate(bestBpm, conf, alt);
    }
}
