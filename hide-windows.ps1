# hide-windows.ps1 — 隐藏标题匹配关键字、且确实是控制台窗口的可见窗口（进程继续后台运行）。
# 只处理 ConsoleWindowClass / PseudoConsoleWindow：避免把标题里恰好含关键字的
# 浏览器、编辑器或 Windows Terminal 整窗隐藏。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File hide-windows.ps1 [关键字...]
# 默认关键字：SnowLuma / voice-packs（voxd 与 GPT-SoVITS 的控制台标题是完整路径，含此目录名）
param([string[]]$Keywords = @('SnowLuma', 'voice-packs', 'voxd', 'GPT-SoVITS', 'api_v2.py'))

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinHider {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static int Hide(string[] titles) {
    int n = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      string kind = cls.ToString();
      if (kind != "ConsoleWindowClass" && kind != "PseudoConsoleWindow") return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string title = sb.ToString();
      foreach (var t in titles) {
        if (t.Length > 0 && title.Contains(t)) { ShowWindow(h, 0); n++; break; }
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@

$n = [WinHider]::Hide($Keywords)
Write-Output $n
