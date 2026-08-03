using System.Diagnostics;
using System.Globalization;

namespace Imagine3D.Media;

/// Streams raw RGBA frames straight into ffmpeg's stdin and muxes the original MP3
/// alongside. Nothing is ever PNG-encoded, written to disk, or re-decoded.
///
/// Because the renderer produces frame N for exactly t = N/fps and this writes them
/// in order, audio/video drift is impossible by construction - a slow frame makes
/// the render take longer, it never desyncs.
public sealed class FramePipe : IDisposable
{
    readonly Process _proc;
    readonly Stream _stdin;
    readonly Task<string> _stderr;
    readonly int _frameBytes;
    bool _closed;

    public int FramesWritten { get; private set; }
    public string OutputPath { get; }

    public FramePipe(
        Ffmpeg ffmpeg, string outputPath, int renderW, int renderH,
        int outW, int outH, int fps, string mp3Path, string encoder, int crf)
    {
        OutputPath = outputPath;
        _frameBytes = renderW * renderH * 4;
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);

        // WebGL readPixels returns rows bottom-up, so every frame arrives vertically
        // flipped; vflip is not optional.
        var filters = new List<string> { "vflip" };
        if (renderW != outW || renderH != outH)
            filters.Add($"scale={outW}:{outH}:flags=lanczos");
        // yuv420p for players that refuse anything else.
        filters.Add("format=yuv420p");

        string vcodec = encoder switch
        {
            "h264_nvenc" => $"-c:v h264_nvenc -preset p5 -rc vbr -cq {crf}",
            "hevc_nvenc" => $"-c:v hevc_nvenc -preset p5 -rc vbr -cq {crf} -tag:v hvc1",
            _ => $"-c:v libx264 -preset slow -crf {crf}",
        };

        var args =
            $"-y -hide_banner -loglevel error " +
            $"-f rawvideo -pix_fmt rgba -s {renderW}x{renderH} " +
            $"-r {fps.ToString(CultureInfo.InvariantCulture)} -i - " +
            $"-i \"{mp3Path}\" " +
            $"-map 0:v:0 -map 1:a:0 " +
            $"-vf \"{string.Join(",", filters)}\" {vcodec} " +
            // Re-encode audio rather than copy: an MP3 stream in MP4 plays back
            // unreliably, and AAC at 320k is transparent for this purpose.
            $"-c:a aac -b:a 320k -shortest -movflags +faststart \"{outputPath}\"";

        var psi = new ProcessStartInfo(ffmpeg.ExePath, args)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        _proc = Process.Start(psi)
            ?? throw new Exception("could not start ffmpeg for frame piping");
        _stdin = _proc.StandardInput.BaseStream;
        // Drain stderr continuously - a full pipe buffer would deadlock the write side.
        _stderr = _proc.StandardError.ReadToEndAsync();
        _ = _proc.StandardOutput.ReadToEndAsync();
    }

    public async Task WriteFrameAsync(ReadOnlyMemory<byte> rgba, CancellationToken ct = default)
    {
        if (_closed) throw new InvalidOperationException("frame pipe already closed");

        if (rgba.Length != _frameBytes)
            throw new ArgumentException(
                $"frame is {rgba.Length} bytes, expected {_frameBytes} " +
                $"({_frameBytes / 4} pixels of RGBA)");

        if (_proc.HasExited)
            throw new Exception($"ffmpeg exited early ({_proc.ExitCode}):\n{await _stderr}");

        await _stdin.WriteAsync(rgba, ct);
        FramesWritten++;
    }

    /// Close stdin and wait for ffmpeg to finish writing the container.
    public async Task<string> FinishAsync()
    {
        if (_closed) return OutputPath;
        _closed = true;

        _stdin.Flush();
        _stdin.Close();
        await _proc.WaitForExitAsync();

        var err = await _stderr;
        if (_proc.ExitCode != 0)
            throw new Exception($"ffmpeg encode failed ({_proc.ExitCode}):\n{err}");
        if (!File.Exists(OutputPath))
            throw new Exception($"ffmpeg reported success but produced no file at {OutputPath}\n{err}");

        return OutputPath;
    }

    public void Dispose()
    {
        if (!_closed)
        {
            // Abandoned mid-render (cancel or crash): kill ffmpeg rather than leave
            // it blocked forever on a stdin that will never deliver another frame.
            try { _stdin.Close(); } catch { /* already gone */ }
            try { if (!_proc.WaitForExit(3000)) _proc.Kill(entireProcessTree: true); }
            catch { /* already gone */ }
            _closed = true;
        }
        _proc.Dispose();
    }
}
