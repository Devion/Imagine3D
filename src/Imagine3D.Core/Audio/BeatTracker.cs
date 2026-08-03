namespace Imagine3D.Audio;

/// Beat tracking by dynamic programming (Ellis 2007): find the sequence of onset
/// peaks that jointly maximises onset strength *and* spacing regularity, so a
/// missed kick doesn't derail the grid the way naive peak-picking does.
public static class BeatTracker
{
    /// tightness: how strongly the grid is held to the target period. Higher is
    /// stiffer; 100 tracks steady material well and rides out small hesitations.
    public static double[] Track(
        float[] onset, double frameRate, double bpm, double timeOffset = 0, double tightness = 100)
    {
        int n = onset.Length;
        if (n < 4) return [];

        double period = 60.0 / bpm * frameRate;
        if (period < 2) return [];

        var score = new double[n];
        var back = new int[n];

        int searchLo = (int)Math.Round(period * 0.5);
        int searchHi = (int)Math.Round(period * 2.0);

        for (int t = 0; t < n; t++)
        {
            double bestScore = double.NegativeInfinity;
            int bestPrev = -1;

            int lo = Math.Max(0, t - searchHi);
            int hi = t - searchLo;
            for (int p = lo; p <= hi; p++)
            {
                // Log-squared deviation from the ideal period: symmetric in
                // half/double time, so it penalises 2x and 0.5x gaps equally.
                double dev = Math.Log((t - p) / period);
                double s = score[p] - tightness * dev * dev;
                if (s > bestScore) { bestScore = s; bestPrev = p; }
            }

            if (bestPrev < 0) { score[t] = onset[t]; back[t] = -1; }
            else { score[t] = onset[t] + bestScore; back[t] = bestPrev; }
        }

        // Start the backtrace from the best score in the final period, so the grid
        // isn't anchored to a stray transient in the fade-out.
        int tail = Math.Max(0, n - (int)Math.Round(period));
        int end = tail;
        for (int t = tail; t < n; t++) if (score[t] > score[end]) end = t;

        var beats = new List<int>();
        for (int t = end; t >= 0; t = back[t])
        {
            beats.Add(t);
            if (back[t] < 0) break;
        }
        beats.Reverse();

        return beats.Select(b => Math.Max(0, b / frameRate + timeOffset)).ToArray();
    }

    /// Which beat starts the bar. Tries all `beatsPerBar` phases and keeps the one
    /// whose beats carry the most low-frequency energy - the kick usually lands on 1.
    public static int FindDownbeatPhase(double[] beats, Spectrogram spec, int beatsPerBar = 4)
    {
        if (beats.Length < beatsPerBar) return 0;

        int loBin = spec.HzToBin(30), hiBin = spec.HzToBin(150);
        double Energy(double t)
        {
            int f = spec.TimeToFrame(t);
            double sum = 0;
            for (int b = loBin; b <= hiBin; b++) sum += spec.Mag[f][b];
            return sum;
        }

        int bestPhase = 0;
        double bestScore = double.NegativeInfinity;
        for (int phase = 0; phase < beatsPerBar; phase++)
        {
            double sum = 0;
            for (int i = phase; i < beats.Length; i += beatsPerBar) sum += Energy(beats[i]);
            int count = (beats.Length - phase + beatsPerBar - 1) / beatsPerBar;
            double avg = count > 0 ? sum / count : 0;
            if (avg > bestScore) { bestScore = avg; bestPhase = phase; }
        }
        return bestPhase;
    }

    /// Synthesise a perfectly regular grid. Used when the user pins the BPM, and as
    /// the fallback when tracking confidence is too low to trust.
    public static double[] Grid(double bpm, double duration, double offset = 0)
    {
        double period = 60.0 / Math.Max(1e-6, bpm);
        var beats = new List<double>();
        for (double t = offset; t < duration; t += period)
            if (t >= 0) beats.Add(t);
        return beats.ToArray();
    }
}
