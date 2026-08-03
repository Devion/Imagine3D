namespace Imagine3D.Audio;

/// Magnitude STFT of a mono signal. Every later stage (onset, bands, MFCC,
/// structure) reads from this one pass so the audio is only transformed once.
public sealed class Spectrogram
{
    public int FftSize { get; }
    public int Hop { get; }
    public int SampleRate { get; }
    public int Frames { get; }
    public int Bins { get; }

    /// [frame][bin] magnitudes.
    public float[][] Mag { get; }

    /// Analysis frames per second.
    public double FrameRate => (double)SampleRate / Hop;

    public double BinHz => (double)SampleRate / FftSize;

    public Spectrogram(float[] samples, int sampleRate, int fftSize = 2048, int hop = 512)
    {
        SampleRate = sampleRate;
        FftSize = fftSize;
        Hop = hop;
        Bins = fftSize / 2 + 1;
        Frames = Math.Max(1, 1 + (Math.Max(0, samples.Length - fftSize) / hop));
        Mag = new float[Frames][];

        var window = Fft.Hann(fftSize);
        var re = new float[fftSize];
        var im = new float[fftSize];

        for (int f = 0; f < Frames; f++)
        {
            int off = f * hop;
            for (int i = 0; i < fftSize; i++)
            {
                int s = off + i;
                re[i] = s < samples.Length ? samples[s] * window[i] : 0f;
                im[i] = 0f;
            }
            Fft.Forward(re, im);

            var m = new float[Bins];
            for (int b = 0; b < Bins; b++)
                m[b] = MathF.Sqrt(re[b] * re[b] + im[b] * im[b]);
            Mag[f] = m;
        }
    }

    public double FrameToTime(int frame) => frame * (double)Hop / SampleRate;

    /// Seconds to add to a frame index to get the true time of the event it
    /// describes. Two corrections, both systematic:
    ///   + FftSize/2 - a frame's window STARTS at f*hop, so its energy is centred
    ///     half a window later;
    ///   - Hop/2 - spectral flux is a backward difference between frames f-1 and f,
    ///     so the rise it reports actually happened between them.
    /// Without this the whole beat grid sits ~88ms late and every effect drifts
    /// audibly behind the music.
    public double EventTimeOffset => (FftSize / 2.0 - Hop / 2.0) / SampleRate;

    public int TimeToFrame(double seconds) =>
        Math.Clamp((int)Math.Round(seconds * SampleRate / Hop), 0, Frames - 1);

    /// Index of the bin nearest a frequency in Hz.
    public int HzToBin(double hz) => Math.Clamp((int)Math.Round(hz / BinHz), 0, Bins - 1);
}
