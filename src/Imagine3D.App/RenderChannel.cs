using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Imagine3D.App;

public sealed record ChannelMessage(bool IsBinary, byte[] Binary, string Text);

/// Request/response wrapper over the page's WebSocket.
///
/// The render loop is strictly lockstep - one frame requested, one frame returned -
/// which is what makes the output deterministic and gives natural backpressure:
/// the page cannot run ahead and buffer frames faster than ffmpeg consumes them.
public sealed class RenderChannel(WebSocket socket) : IDisposable
{
    readonly WebSocket _ws = socket;
    readonly Channel<ChannelMessage> _incoming =
        Channel.CreateBounded<ChannelMessage>(new BoundedChannelOptions(4)
        {
            FullMode = BoundedChannelFullMode.Wait,
        });

    readonly SemaphoreSlim _sendLock = new(1, 1);
    Task? _receiveLoop;
    volatile bool _closed;

    public bool IsOpen => !_closed && _ws.State == WebSocketState.Open;

    public void Start(CancellationToken ct) => _receiveLoop = ReceiveLoopAsync(ct);

    async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var pool = ArrayPool<byte>.Shared;
        var buffer = pool.Rent(128 * 1024);
        try
        {
            while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _closed = true;
                        _incoming.Writer.TryComplete();
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                    // A 1080p RGBA frame is ~8 MB and always arrives fragmented;
                    // accumulate until the browser says the message is complete.
                } while (!result.EndOfMessage);

                var bytes = ms.ToArray();
                var msg = result.MessageType == WebSocketMessageType.Binary
                    ? new ChannelMessage(true, bytes, "")
                    : new ChannelMessage(false, [], Encoding.UTF8.GetString(bytes));

                await _incoming.Writer.WriteAsync(msg, ct);
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (WebSocketException) { /* page navigated away or closed */ }
        finally
        {
            pool.Return(buffer);
            _closed = true;
            _incoming.Writer.TryComplete();
        }
    }

    public async Task SendJsonAsync(object payload, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(payload, Json.Options);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _sendLock.WaitAsync(ct);
        try
        {
            if (_ws.State != WebSocketState.Open) return;
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
        }
        finally { _sendLock.Release(); }
    }

    /// Await the next message from the page, failing loudly if it reports an error
    /// or drops the connection rather than hanging forever.
    public async Task<ChannelMessage> ReadAsync(TimeSpan timeout, CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            return await _incoming.Reader.ReadAsync(cts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"The render page did not respond within {timeout.TotalSeconds:F0}s. " +
                "It most likely threw while drawing a frame - check the devtools console.");
        }
        catch (ChannelClosedException)
        {
            throw new IOException("The render page disconnected mid-render.");
        }
    }

    /// Read messages until a binary one arrives, surfacing any error the page
    /// reports along the way. Text messages in between are status/thumbnails.
    ///
    /// `runId` scopes what counts as our failure: the page tags each reply with
    /// the run it belongs to, and an error raised for a different run - one that
    /// was cancelled, or superseded by this one - must not fail this render.
    public async Task<byte[]> ReadBinaryAsync(
        TimeSpan timeout, string? runId = null,
        Action<string>? onText = null, CancellationToken ct = default)
    {
        while (true)
        {
            var msg = await ReadAsync(timeout, ct);
            if (msg.IsBinary) return msg.Binary;

            if (Peek(msg.Text, "type") == "error")
            {
                var owner = Peek(msg.Text, "runId");
                if (runId is null || owner is null || owner == runId)
                    throw new Exception($"Render page error: {Peek(msg.Text, "message") ?? msg.Text}");
                continue;
            }
            onText?.Invoke(msg.Text);
        }
    }

    /// Throw away anything the page has queued up. A run that was cancelled or
    /// timed out can leave a frame or a thumbnail behind, and reading that as the
    /// next run's reply desyncs the whole lockstep protocol.
    public int Drain()
    {
        int dropped = 0;
        while (_incoming.Reader.TryRead(out _)) dropped++;
        return dropped;
    }

    /// One top-level string property out of a page message, or null.
    public static string? Peek(string json, string property)
    {
        try
        {
            using var d = JsonDocument.Parse(json);
            return d.RootElement.TryGetProperty(property, out var v)
                   && v.ValueKind == JsonValueKind.String
                ? v.GetString()
                : null;
        }
        catch { return null; }
    }

    public void Dispose()
    {
        _closed = true;
        _incoming.Writer.TryComplete();
        _sendLock.Dispose();
    }
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
    };

    public static readonly JsonSerializerOptions Indented = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };
}
