// desktop-launch — run a command on a separate Win32 desktop of the interactive
// window station, so its windows never reach the user's screen, taskbar or Alt-Tab.
//
//   desktop-launch.exe run  <desktop> <exe> [args...]   run, wait, return its exit code
//   desktop-launch.exe list <desktop>                   print visible top-level windows there
//
// Built on demand by src/bot-desktop.js with the .NET Framework csc.exe that ships
// with Windows (C# 5 only — no newer syntax). See "Hiding bot windows" in CLAUDE.md.
//
// Child processes inherit their parent's desktop, so launching `node run-once.js`
// here puts every Chrome it spawns on the same desktop with no bot code involved.
// The child is placed in a kill-on-close job: if this launcher dies, nothing is
// left running invisibly.
using System;
using System.Text;
using System.Runtime.InteropServices;

static class DesktopLaunch {
  // Exit code meaning "the command was never started" — the caller falls back to
  // running on the normal desktop. Anything else is the command's own exit code.
  const int EXIT_NOT_STARTED = 113;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desk, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

  const uint GENERIC_ALL = 0x10000000;
  const uint DESKTOP_READOBJECTS = 0x0001, DESKTOP_ENUMERATE = 0x0040;
  const uint CREATE_SUSPENDED = 0x00000004;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 1;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const int JobObjectExtendedLimitInformation = 9;

  static int Main(string[] args) {
    if (args.Length >= 2 && args[0] == "list") return List(args[1]);
    if (args.Length >= 3 && args[0] == "run") return Run(args);
    Console.Error.WriteLine("usage: desktop-launch run <desktop> <exe> [args...] | desktop-launch list <desktop>");
    return EXIT_NOT_STARTED;
  }

  static bool ValidName(string name) {
    if (name.Length == 0 || name.Length > 32) return false;
    foreach (char c in name) if (!(char.IsLetterOrDigit(c) && c < 128) && c != '_' && c != '-') return false;
    return true;
  }

  static int Run(string[] args) {
    string name = args[1];
    if (!ValidName(name)) { Console.Error.WriteLine("[desktop-launch] invalid desktop name"); return EXIT_NOT_STARTED; }

    // Creates the desktop, or opens it if a bot process already lives there.
    IntPtr desk = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (desk == IntPtr.Zero) {
      Console.Error.WriteLine("[desktop-launch] CreateDesktop failed: " + Marshal.GetLastWin32Error());
      return EXIT_NOT_STARTED;
    }

    var cmd = new StringBuilder();
    for (int i = 2; i < args.Length; i++) { if (i > 2) cmd.Append(' '); cmd.Append(Quote(args[i])); }

    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = "WinSta0\\" + name;
    // Pass our own stdio through so `>> run.log 2>&1` on the caller still captures the child.
    IntPtr hin = GetStdHandle(-10), hout = GetStdHandle(-11), herr = GetStdHandle(-12);
    if (Usable(hout) || Usable(herr)) {
      foreach (IntPtr h in new IntPtr[] { hin, hout, herr }) if (Usable(h)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
      si.dwFlags |= STARTF_USESTDHANDLES;
      si.hStdInput = hin; si.hStdOutput = hout; si.hStdError = herr;
    }

    PROCESS_INFORMATION pi;
    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi)) {
      Console.Error.WriteLine("[desktop-launch] CreateProcess failed: " + Marshal.GetLastWin32Error());
      CloseDesktop(desk);
      return EXIT_NOT_STARTED;
    }

    // Kill-on-close job: the child tree cannot outlive this launcher. Best-effort —
    // if the job can't be set up the command still runs.
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job != IntPtr.Zero) {
      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        AssignProcessToJobObject(job, pi.hProcess);
    }

    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
    CloseDesktop(desk);
    return unchecked((int)code);
  }

  static bool Usable(IntPtr h) { return h != IntPtr.Zero && h != new IntPtr(-1); }

  // Quote one argument so CommandLineToArgvW / the MSVC runtime parse it back unchanged.
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in a) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\', slashes); sb.Append(c); }
      slashes = 0;
    }
    sb.Append('\\', slashes * 2);
    sb.Append('"');
    return sb.ToString();
  }

  static int List(string name) {
    if (!ValidName(name)) { Console.Error.WriteLine("[desktop-launch] invalid desktop name"); return 1; }
    IntPtr desk = OpenDesktop(name, 0, false, DESKTOP_READOBJECTS | DESKTOP_ENUMERATE);
    if (desk == IntPtr.Zero) { Console.WriteLine("desktop '" + name + "' does not exist (no bot process is running on it)"); return 0; }
    int count = 0;
    EnumDesktopWindows(desk, delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      var cls = new StringBuilder(128); GetClassName(h, cls, 128);
      var title = new StringBuilder(256); GetWindowText(h, title, 256);
      Console.WriteLine("pid=" + pid + " class=" + cls + " rect=(" + r.L + "," + r.T + ") " + (r.R - r.L) + "x" + (r.B - r.T) + " title=" + title);
      count++;
      return true;
    }, IntPtr.Zero);
    Console.WriteLine(count + " visible window(s) on desktop '" + name + "'");
    CloseDesktop(desk);
    return 0;
  }
}
