using Imagine3D.Pipeline;

namespace Imagine3D.App;

/// Process-wide state shared between the HTTP API and the WebSocket: the page's
/// render channel and whatever generation run is currently in flight.
public sealed class Session
{
    readonly Lock _gate = new();
    readonly Queue<string> _log = new();
    RenderChannel? _channel;
    CancellationTokenSource? _running;

    public string? CurrentProject { get; set; }

    /// Last failure, surfaced through /api/health so a stalled run can be
    /// diagnosed without the page attached.
    public string? LastError { get; private set; }

    public void Fail(string message)
    {
        lock (_gate) LastError = message;
        Log($"FAILED: {message}");
    }

    public void Log(string line)
    {
        lock (_gate)
        {
            _log.Enqueue($"{DateTime.Now:HH:mm:ss} {line}");
            while (_log.Count > 60) _log.Dequeue();
        }
    }

    public string[] RecentLog()
    {
        lock (_gate) return _log.ToArray();
    }

    public RenderChannel? Channel
    {
        get { lock (_gate) return _channel; }
        set { lock (_gate) _channel = value; }
    }

    public bool IsBusy
    {
        get { lock (_gate) return _running is { IsCancellationRequested: false }; }
    }

    /// Wait for the page to attach a channel that is not `previous`.
    /// Used after asking the page to reload, so a caller can resume once the
    /// fresh document has connected rather than talking to a dead socket.
    public async Task<RenderChannel?> WaitForNewChannelAsync(RenderChannel? previous, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var ch = Channel;
            if (ch is { IsOpen: true } && !ReferenceEquals(ch, previous)) return ch;
            await Task.Delay(150);
        }
        return null;
    }

    /// Claim the single generation slot. Returns null when a run is already going -
    /// two concurrent renders would fight over the one render channel.
    public CancellationTokenSource? TryBeginRun()
    {
        lock (_gate)
        {
            if (_running is { IsCancellationRequested: false }) return null;
            _running = new CancellationTokenSource();
            return _running;
        }
    }

    public void EndRun()
    {
        lock (_gate)
        {
            _running?.Dispose();
            _running = null;
        }
    }

    public void Cancel()
    {
        lock (_gate) _running?.Cancel();
    }

    /// Push a progress tick to the page. Fire-and-forget: a dropped progress
    /// message must never stall or fail the actual generation.
    public IProgress<StageProgress> ProgressSink() => new Progress<StageProgress>(p =>
    {
        Log($"[{p.Stage}] {p.Fraction:P0} {p.Detail}");
        var ch = Channel;
        if (ch is null || !ch.IsOpen) return;
        _ = ch.SendJsonAsync(new
        {
            cmd = "progress",
            stage = p.Stage.ToString().ToLowerInvariant(),
            fraction = p.Fraction,
            detail = p.Detail,
            thumbnail = p.Thumbnail,
            failed = p.Failed,
        });
    });
}
