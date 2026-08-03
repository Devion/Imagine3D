namespace Imagine3D.Audio;

/// In-place iterative radix-2 complex FFT. Small enough to keep in-tree, which
/// keeps the whole analysis chain dependency-free and deterministic.
public static class Fft
{
    /// Transforms re/im in place. Length must be a power of two.
    public static void Forward(float[] re, float[] im)
    {
        int n = re.Length;
        if (n != im.Length || (n & (n - 1)) != 0)
            throw new ArgumentException("FFT length must be a power of two and match");

        // Bit-reversal permutation.
        for (int i = 1, j = 0; i < n; i++)
        {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j)
            {
                (re[i], re[j]) = (re[j], re[i]);
                (im[i], im[j]) = (im[j], im[i]);
            }
        }

        for (int len = 2; len <= n; len <<= 1)
        {
            double ang = -2 * Math.PI / len;
            float wRe = (float)Math.Cos(ang), wIm = (float)Math.Sin(ang);
            for (int i = 0; i < n; i += len)
            {
                float curRe = 1f, curIm = 0f;
                for (int k = 0; k < len / 2; k++)
                {
                    int a = i + k, b = i + k + len / 2;
                    float tRe = re[b] * curRe - im[b] * curIm;
                    float tIm = re[b] * curIm + im[b] * curRe;
                    re[b] = re[a] - tRe;
                    im[b] = im[a] - tIm;
                    re[a] += tRe;
                    im[a] += tIm;
                    float nRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = nRe;
                }
            }
        }
    }

    public static float[] Hann(int n)
    {
        var w = new float[n];
        for (int i = 0; i < n; i++) w[i] = (float)(0.5 * (1 - Math.Cos(2 * Math.PI * i / (n - 1))));
        return w;
    }
}
