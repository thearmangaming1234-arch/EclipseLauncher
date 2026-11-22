using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Windows.Forms;

internal static class UpdateScreen
{
    private static int parentPid;
    private static string imagePath, readyPath, logPath;
    private static DateTime launchedAt;
    private static bool parentExited;
    private static DateTime? relaunchedAt;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            parentPid = int.Parse(Arg(args, "--parent-pid"));
            imagePath = Arg(args, "--image");
            readyPath = Arg(args, "--ready");
            logPath = Arg(args, "--log");
            launchedAt = DateTime.Now;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var form = new Form { Text = "Eclipse Launcher", FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.CenterScreen, ClientSize = new Size(820, 520), BackColor = Color.FromArgb(8, 13, 25), TopMost = true, ShowInTaskbar = true };
            var picture = new PictureBox { Location = new Point(22, 22), Size = new Size(776, 436), SizeMode = PictureBoxSizeMode.Zoom, BackColor = form.BackColor, Image = Image.FromFile(imagePath) };
            picture.Region = RoundedRegion(picture.Width, picture.Height, 20);
            form.Controls.Add(picture);
            var progress = new ProgressBar { Location = new Point(22, 476), Size = new Size(776, 16), Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 24 };
            form.Controls.Add(progress);
            var timer = new Timer { Interval = 400 };
            timer.Tick += (sender, eventArgs) =>
            {
                if (!parentExited)
                {
                    try { using (Process.GetProcessById(parentPid)) { return; } }
                    catch { parentExited = true; }
                }
                var relaunched = Process.GetProcessesByName("Eclipse Launcher")
                    .Where(p => { try { return p.StartTime > launchedAt; } catch { return false; } }).ToArray();
                foreach (var process in relaunched) process.Dispose();
                if (relaunched.Length > 0)
                {
                    if (!relaunchedAt.HasValue) relaunchedAt = DateTime.Now;
                    else if ((DateTime.Now - relaunchedAt.Value).TotalSeconds >= 3) form.Close();
                }
            };
            form.Shown += (sender, eventArgs) => { File.WriteAllText(readyPath, "ready"); timer.Start(); };
            form.FormClosed += (sender, eventArgs) => { timer.Stop(); timer.Dispose(); picture.Image.Dispose(); };
            Application.Run(form);
            return 0;
        }
        catch (Exception error)
        {
            try { File.AppendAllText(logPath ?? Path.Combine(Path.GetTempPath(), "eclipse-update-screen.log"), error + Environment.NewLine); } catch { }
            return 1;
        }
    }

    private static string Arg(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        if (index < 0 || index + 1 >= args.Length) throw new ArgumentException("Missing argument " + name);
        return args[index + 1];
    }

    private static Region RoundedRegion(int width, int height, int radius)
    {
        int d = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(0, 0, d, d, 180, 90);
        path.AddArc(width - d, 0, d, d, 270, 90);
        path.AddArc(width - d, height - d, d, d, 0, 90);
        path.AddArc(0, height - d, d, d, 90, 90);
        path.CloseFigure();
        var region = new Region(path);
        path.Dispose();
        return region;
    }
}
