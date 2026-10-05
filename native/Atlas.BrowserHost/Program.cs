using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

static class Program
{
    const int Limit = 65536;
    static readonly SemaphoreSlim OutputLock = new(1, 1);
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static string PipeName()
    {
        string identity = OperatingSystem.IsWindows() ? WindowsIdentity.GetCurrent().User!.Value : Environment.UserName;
        return "atlas-browser-v1-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))[..24];
    }
    static bool Id(string id) => id.Length == 32 && id.All(c => c >= 'a' && c <= 'p');
    static async Task<byte[]?> Read(Stream stream, CancellationToken token)
    {
        byte[] prefix = new byte[4]; int first = await stream.ReadAsync(prefix.AsMemory(0, 1), token);
        if (first == 0) return null;
        await stream.ReadExactlyAsync(prefix.AsMemory(1, 3), token);
        uint length = BinaryPrimitives.ReadUInt32LittleEndian(prefix);
        if (length == 0 || length > Limit) throw new InvalidDataException();
        byte[] data = new byte[(int)length]; await stream.ReadExactlyAsync(data, token);
        _ = new UTF8Encoding(false, true).GetString(data); using var parsed = JsonDocument.Parse(data);
        return data;
    }
    static async Task Write(Stream stream, byte[] data, SemaphoreSlim guard, CancellationToken token)
    {
        if (data.Length == 0 || data.Length > Limit) throw new InvalidDataException();
        await guard.WaitAsync(token);
        try { byte[] prefix = new byte[4]; BinaryPrimitives.WriteUInt32LittleEndian(prefix, (uint)data.Length); await stream.WriteAsync(prefix, token); await stream.WriteAsync(data, token); await stream.FlushAsync(token); }
        finally { guard.Release(); }
    }
    static byte[] Encode(object value) => JsonSerializer.SerializeToUtf8Bytes(value, Json);
    static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--broker" && Id(args[1])) { await Broker(args[1]); return 0; }
            // Chrome supplies the extension origin as its first argument. No arbitrary
            // paths or command lines are accepted from protocol messages.
            var configPath = Path.Combine(AppContext.BaseDirectory, "atlas-host.json");
            using var config = JsonDocument.Parse(await File.ReadAllTextAsync(configPath));
            string extensionId = config.RootElement.GetProperty("extensionId").GetString()!;
            if (!Id(extensionId) || args.Length < 1 || args[0] != "chrome-extension://" + extensionId + "/") return 1;
            await Host(args[0]); return 0;
        }
        catch { Console.Error.WriteLine("ATLAS_NATIVE_ERROR"); return 1; } // Never raw exception/path/payload.
    }
    static async Task Host(string origin)
    {
        using var stop = new CancellationTokenSource();
        using var pipe = new NamedPipeClientStream(".", PipeName(), PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(5000, stop.Token);
        using var pipeLock = new SemaphoreSlim(1, 1);
        await Write(pipe, Encode(new { kind = "hostHello", origin }), pipeLock, stop.Token);
        async Task Copy(Stream source, Stream destination, SemaphoreSlim guard)
        {
            try { while (await Read(source, stop.Token) is { } data) await Write(destination, data, guard, stop.Token); }
            finally { stop.Cancel(); }
        }
        await Task.WhenAny(Copy(Console.OpenStandardInput(), pipe, pipeLock), Copy(pipe, Console.OpenStandardOutput(), OutputLock)); stop.Cancel();
    }
    sealed class Connection(NamedPipeServerStream stream)
    {
        public NamedPipeServerStream Stream { get; } = stream;
        public SemaphoreSlim Guard { get; } = new(1, 1);
    }
    static async Task Broker(string extensionId)
    {
        // Only one Atlas broker per OS user; multiple Chrome hosts are multiplexed.
        using var mutex = new Mutex(false, PipeName() + "-broker");
        bool owned; try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
        if (!owned) throw new InvalidOperationException();
        using var stop = new CancellationTokenSource();
        var connections = new ConcurrentDictionary<string, Connection>();
        var output = Console.OpenStandardOutput();
        async Task Serve(NamedPipeServerStream pipe)
        {
            string id = Guid.NewGuid().ToString(); using (pipe)
            {
                try
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token); deadline.CancelAfter(5000);
                    byte[] first = await Read(pipe, deadline.Token) ?? throw new InvalidDataException();
                    using var hello = JsonDocument.Parse(first);
                    if (hello.RootElement.EnumerateObject().Count() != 2 || hello.RootElement.GetProperty("kind").GetString() != "hostHello" || hello.RootElement.GetProperty("origin").GetString() != "chrome-extension://" + extensionId + "/") throw new InvalidDataException();
                    if (connections.Count >= 10) throw new InvalidOperationException();
                    var connection = new Connection(pipe); connections[id] = connection;
                    await Write(output, Encode(new { kind = "connected", connectionId = id }), OutputLock, stop.Token);
                    while (await Read(pipe, stop.Token) is { } data)
                    {
                        using var message = JsonDocument.Parse(data);
                        await Write(output, Encode(new { kind = "message", connectionId = id, message = message.RootElement }), OutputLock, stop.Token);
                    }
                }
                catch { /* Only connection lifecycle is reported; no secrets/errors. */ }
                finally { if (connections.TryRemove(id, out _) && !stop.IsCancellationRequested) { try { await Write(output, Encode(new { kind = "disconnected", connectionId = id }), OutputLock, stop.Token); } catch { } } }
            }
        }
        async Task Accept()
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var pipe = new NamedPipeServerStream(PipeName(), PipeDirection.InOut, 10, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    try { await pipe.WaitForConnectionAsync(stop.Token); } catch { pipe.Dispose(); throw; }
                    _ = Serve(pipe);
                }
            }
            catch { stop.Cancel(); }
        }
        var accepting = Accept();
        try
        {
            while (await Read(Console.OpenStandardInput(), stop.Token) is { } data)
            {
                using var packet = JsonDocument.Parse(data); var root = packet.RootElement;
                if (root.EnumerateObject().Count() != 3 || root.GetProperty("kind").GetString() != "message") throw new InvalidDataException();
                string id = root.GetProperty("connectionId").GetString()!;
                if (connections.TryGetValue(id, out var connection)) { try { await Write(connection.Stream, Encode(root.GetProperty("message")), connection.Guard, stop.Token); } catch { connection.Stream.Dispose(); } }
            }
        }
        finally { stop.Cancel(); foreach (var connection in connections.Values) connection.Stream.Dispose(); await accepting; /* Mutex released by process exit: async continuations need not own its thread. */ }
    }
}
