using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace FeishuReviewLauncher;

internal static class Program
{
    private const string MutexName = "Local\\FeishuCustomerReviewTool";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Contains("--smoke-test", StringComparer.OrdinalIgnoreCase))
        {
            return RunSmokeTest();
        }

        using var mutex = new Mutex(true, MutexName, out var createdNew);
        if (!createdNew)
        {
            OpenExistingInstance();
            return 0;
        }

        ApplicationConfiguration.Initialize();
        using var context = new TrayApplicationContext();
        Application.Run(context);
        return context.ExitCode;
    }

    private static int RunSmokeTest()
    {
        try
        {
            using var host = new ServerHost();
            host.Start();
            return host.WaitUntilReady(TimeSpan.FromSeconds(60)) ? 0 : 2;
        }
        catch
        {
            return 1;
        }
    }

    private static void OpenExistingInstance()
    {
        var portFile = Path.Combine(ServerHost.GetDataRoot(), "runtime.port");
        for (var attempt = 0; attempt < 10; attempt += 1)
        {
            if (File.Exists(portFile) && int.TryParse(File.ReadAllText(portFile), out var port))
            {
                ServerHost.OpenBrowser($"http://127.0.0.1:{port}");
                return;
            }
            Thread.Sleep(300);
        }
        MessageBox.Show("工具正在启动，请稍后再次双击。", "飞书客户素材审核工具", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly ServerHost host = new();
    private readonly NotifyIcon trayIcon;
    private readonly ToolStripMenuItem statusItem;
    private readonly System.Windows.Forms.Timer readinessTimer;
    private int attempts;
    private bool shuttingDown;

    public int ExitCode { get; private set; }

    public TrayApplicationContext()
    {
        statusItem = new ToolStripMenuItem("正在启动…") { Enabled = false };
        var openItem = new ToolStripMenuItem("打开审核工具", null, (_, _) => ServerHost.OpenBrowser(host.Url));
        var dataItem = new ToolStripMenuItem("打开数据目录", null, (_, _) => ServerHost.OpenFolder(ServerHost.GetDataRoot()));
        var exitItem = new ToolStripMenuItem("退出", null, (_, _) => ExitApplication());
        var menu = new ContextMenuStrip();
        menu.Items.AddRange([statusItem, new ToolStripSeparator(), openItem, dataItem, new ToolStripSeparator(), exitItem]);
        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "飞书客户素材审核工具",
            Visible = true,
            ContextMenuStrip = menu,
        };
        trayIcon.DoubleClick += (_, _) => ServerHost.OpenBrowser(host.Url);

        readinessTimer = new System.Windows.Forms.Timer { Interval = 700 };
        readinessTimer.Tick += (_, _) => CheckReadiness();
        try
        {
            host.Start();
            readinessTimer.Start();
        }
        catch (Exception error)
        {
            ExitCode = 1;
            MessageBox.Show($"工具启动失败：{error.Message}\n\n日志目录：{ServerHost.GetDataRoot()}", "飞书客户素材审核工具", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitApplication();
        }
    }

    private void CheckReadiness()
    {
        attempts += 1;
        if (host.HasExited)
        {
            readinessTimer.Stop();
            statusItem.Text = "服务已停止";
            ExitCode = 2;
            MessageBox.Show($"本地服务意外停止。请查看日志：\n{host.LogFile}", "飞书客户素材审核工具", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitApplication();
            return;
        }
        if (host.IsReady())
        {
            readinessTimer.Stop();
            statusItem.Text = "运行中";
            ServerHost.OpenBrowser(host.Url);
            trayIcon.ShowBalloonTip(2500, "飞书客户素材审核工具", "工具已启动，可通过托盘图标重新打开。", ToolTipIcon.Info);
            return;
        }
        if (attempts >= 90)
        {
            readinessTimer.Stop();
            ExitCode = 3;
            MessageBox.Show($"本地服务启动超时。请查看日志：\n{host.LogFile}", "飞书客户素材审核工具", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitApplication();
        }
    }

    private void ExitApplication()
    {
        if (shuttingDown) return;
        shuttingDown = true;
        readinessTimer.Stop();
        trayIcon.Visible = false;
        host.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            readinessTimer.Dispose();
            trayIcon.Dispose();
            host.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal sealed class ServerHost : IDisposable
{
    private readonly object logLock = new();
    private Process? process;
    private StreamWriter? logWriter;
    private bool disposed;

    public int Port { get; private set; }
    public string Url => $"http://127.0.0.1:{Port}";
    public string LogFile { get; private set; } = string.Empty;
    public bool HasExited => process is null || process.HasExited;

    public static string GetDataRoot()
    {
        var overridden = Environment.GetEnvironmentVariable("FEISHU_REVIEW_DATA_DIR");
        return string.IsNullOrWhiteSpace(overridden)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FeishuCustomerReviewTool")
            : Path.GetFullPath(overridden);
    }

    public void Start()
    {
        var root = AppContext.BaseDirectory;
        var nodePath = Path.Combine(root, "runtime", "node.exe");
        var appDirectory = Path.Combine(root, "app");
        var serverPath = Path.Combine(appDirectory, "server.js");
        if (!File.Exists(nodePath) || !File.Exists(serverPath)) throw new FileNotFoundException("程序文件不完整，请重新解压绿色版。", serverPath);

        var dataRoot = GetDataRoot();
        var dataDirectory = Path.Combine(dataRoot, "data");
        var tempDirectory = Path.Combine(dataRoot, "temp");
        var logDirectory = Path.Combine(dataRoot, "logs");
        Directory.CreateDirectory(dataDirectory);
        Directory.CreateDirectory(tempDirectory);
        Directory.CreateDirectory(logDirectory);
        Port = FindFreePort();
        File.WriteAllText(Path.Combine(dataRoot, "runtime.port"), Port.ToString(), Encoding.UTF8);
        LogFile = Path.Combine(logDirectory, $"app-{DateTime.Now:yyyyMMdd}.log");
        logWriter = new StreamWriter(LogFile, append: true, new UTF8Encoding(false)) { AutoFlush = true };

        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = appDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("server.js");
        startInfo.Environment["NODE_ENV"] = "production";
        startInfo.Environment["NEXT_TELEMETRY_DISABLED"] = "1";
        startInfo.Environment["HOSTNAME"] = "127.0.0.1";
        startInfo.Environment["PORT"] = Port.ToString();
        startInfo.Environment["DATABASE_URL"] = $"file:{Path.Combine(dataDirectory, "poc.db")}";
        startInfo.Environment["CREDENTIAL_KEY_PATH"] = Path.Combine(dataDirectory, "credentials.key");
        startInfo.Environment["TEMP"] = tempDirectory;
        startInfo.Environment["TMP"] = tempDirectory;
        process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, eventArgs) => WriteLog(eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => WriteLog(eventArgs.Data);
        if (!process.Start()) throw new InvalidOperationException("无法启动内置服务。 ");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
    }

    public bool IsReady()
    {
        if (HasExited) return false;
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(550) };
            using var response = client.GetAsync($"{Url}/api/accounts").GetAwaiter().GetResult();
            return response.StatusCode == HttpStatusCode.OK;
        }
        catch
        {
            return false;
        }
    }

    public bool WaitUntilReady(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline && !HasExited)
        {
            if (IsReady()) return true;
            Thread.Sleep(250);
        }
        return false;
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private void WriteLog(string? value)
    {
        if (string.IsNullOrEmpty(value) || logWriter is null) return;
        lock (logLock) logWriter.WriteLine($"[{DateTime.Now:O}] {value}");
    }

    public static void OpenBrowser(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    public static void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        try
        {
            if (process is { HasExited: false }) process.Kill(entireProcessTree: true);
            process?.WaitForExit(3000);
        }
        catch { }
        process?.Dispose();
        lock (logLock)
        {
            logWriter?.Dispose();
            logWriter = null;
        }
        try { File.Delete(Path.Combine(GetDataRoot(), "runtime.port")); } catch { }
    }
}
