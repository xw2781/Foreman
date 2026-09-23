// Computer-use support for AI coding agents on Windows: see, and carefully drive, desktop apps.
//
// Everything the agent-facing CLI (computer.ps1) needs that PowerShell cannot do quickly:
//   * the visible-presence overlay shown while an agent drives the mouse and keyboard: a glow
//     along the screen edges, the agent's own pointer gliding to each target, and an
//     always-on-top panel with a Release button (physical Escape releases too);
//   * real input: pointer clicks, drags and wheel (done by the overlay, so the drawn pointer
//     arrives before the real click), keyboard chords and Unicode text;
//   * window listing, activation, and screenshots (PrintWindow, so occluded windows capture
//     correctly and the overlay never appears in the image);
//   * a UI Automation snapshot with numbered elements, and UIA actions on those elements;
//   * the app policy (built-in deny list plus config.json) and small file helpers.
//
// Compiled by computer.ps1 with Add-Type into a cached DLL, using the old csc that ships with
// Windows PowerShell 5.1, so this must stay C# 5 and ASCII.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace AgentTaskCenter.ScreenControl
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct SIZE { public int cx; public int cy; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public int biSize;
            public int biWidth;
            public int biHeight;
            public short biPlanes;
            public short biBitCount;
            public int biCompression;
            public int biSizeImage;
            public int biXPelsPerMeter;
            public int biYPelsPerMeter;
            public int biClrUsed;
            public int biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        // MOUSEINPUT is the union's largest member, so INPUT keeps the 40 bytes x64 expects.
        // Any other size makes SendInput reject every event.
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public INPUTUNION u; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst,
            ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after,
            int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, string lParam,
            uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, StringBuilder lParam,
            uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")]
        public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam,
            uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern short VkKeyScanEx(char ch, IntPtr layout);
        [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc proc, IntPtr hMod, uint threadId);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool MoveFileEx(string from, string to, uint flags);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h,
            IntPtr src, int sx, int sy, int rop);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] public static extern bool GdiFlush();
        [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc,
            ref BITMAPINFOHEADER header, uint usage, out IntPtr bits, IntPtr section, uint offset);

        public const int ULW_ALPHA = 2;
        public const uint GA_ROOT = 2;
        public const uint GW_OWNER = 4;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const int SW_SHOW = 5;
        public const int SW_RESTORE = 9;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x1000;

        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;

        public const int WH_KEYBOARD_LL = 13;
        public const uint LLKHF_INJECTED = 0x10;
        public const uint PW_RENDERFULLCONTENT = 0x2;
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int DWMWA_CLOAKED = 14;

        /// <summary>
        /// Works in real screen pixels, the ones a screenshot shows. Per-monitor awareness is
        /// needed for that: when the session's scale changed after logon (an RDP reconnect at
        /// another size), Windows stretches a merely system-aware process, and its coordinates
        /// then run 25% or more away from the screenshot's.
        /// </summary>
        public static void UseRealPixels()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; // PER_MONITOR_AWARE_V2
            }
            catch (EntryPointNotFoundException) { }
            SetProcessDPIAware();
        }

        /// <summary>Keeps one of the overlay's own windows out of every screenshot (Windows 10 2004+).</summary>
        public static void HideFromCapture(IntPtr hwnd)
        {
            try { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE); }
            catch (EntryPointNotFoundException) { }
        }

        // WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        public const int EX_CLICK_THROUGH = 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000;
        // WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        public const int EX_PANEL = 0x00000080 | 0x08000000;
    }

    /// <summary>The real, system pointer: the one that actually clicks.</summary>
    public static class RealPointer
    {
        public static bool InputSizeIsRight
        {
            get { return Marshal.SizeOf(typeof(Native.INPUT)) == (IntPtr.Size == 8 ? 40 : 28); }
        }

        public static Native.POINT Where()
        {
            Native.POINT p;
            Native.GetCursorPos(out p);
            return p;
        }

        /// <summary>Puts the real pointer on a pixel; a drag also sends a move event so the app tracks it.</summary>
        public static bool MoveTo(int x, int y, bool announce)
        {
            Native.SetCursorPos(x, y);
            if (announce) Send(Native.MOUSEEVENTF_MOVE, 0);
            Native.POINT p = Where();
            return Math.Abs(p.X - x) <= 1 && Math.Abs(p.Y - y) <= 1;
        }

        /// <summary>button: 0 left, 1 right, 2 middle.</summary>
        public static bool Button(int button, bool down)
        {
            uint flags;
            if (button == 1) flags = down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP;
            else if (button == 2) flags = down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP;
            else flags = down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP;
            return Send(flags, 0);
        }

        /// <summary>One wheel movement; delta is in wheel units (120 per notch, positive = up / right).</summary>
        public static bool Wheel(int delta, bool horizontal)
        {
            return Send(horizontal ? Native.MOUSEEVENTF_HWHEEL : Native.MOUSEEVENTF_WHEEL, unchecked((uint)delta));
        }

        private static bool Send(uint flags, uint data)
        {
            Native.INPUT[] input = new Native.INPUT[1];
            input[0].type = 0; // INPUT_MOUSE; a zero dx/dy with no ABSOLUTE flag leaves the position alone
            input[0].u.mi.dwFlags = flags;
            input[0].u.mi.mouseData = data;
            return Native.SendInput(1, input, Marshal.SizeOf(typeof(Native.INPUT))) == 1;
        }
    }

    /// <summary>One key of a chord: a virtual key, or a character sent as Unicode.</summary>
    public class KeySpec
    {
        public ushort Vk;
        public bool Extended;
        public bool Unicode;
        public char Char;
        public string Label = "";
    }

    /// <summary>A parsed `+`-separated chord such as Control_L+Shift_L+period.</summary>
    public class Chord
    {
        public List<KeySpec> Modifiers = new List<KeySpec>();
        public KeySpec Key;
        public string Error;      // bad syntax or unknown key: exit 2
        public string Refusal;    // a forbidden key such as the Windows key: exit 4

        public string Display
        {
            get
            {
                List<string> parts = new List<string>();
                foreach (KeySpec m in Modifiers) parts.Add(m.Label);
                if (Key != null) parts.Add(Key.Label);
                return string.Join("+", parts.ToArray());
            }
        }
    }

    /// <summary>Keyboard input: keysym-style chords and literal Unicode text.</summary>
    public static class Keyboard
    {
        private static readonly Dictionary<string, int> Named = BuildNames();
        private static readonly Dictionary<string, char> Punctuation = BuildPunctuation();
        private static readonly string[] Forbidden = {
            "win", "windows", "win_l", "win_r", "lwin", "rwin", "meta", "meta_l", "meta_r",
            "super", "super_l", "super_r", "cmd", "command", "os", "hyper", "hyper_l", "hyper_r",
            "start", "windows_l", "windows_r"
        };

        private const int EXT = 0x10000;

        private static Dictionary<string, int> BuildNames()
        {
            Dictionary<string, int> d = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            d["return"] = 0x0D; d["enter"] = 0x0D; d["kp_enter"] = 0x0D | EXT; d["numpad_enter"] = 0x0D | EXT;
            d["tab"] = 0x09; d["escape"] = 0x1B; d["esc"] = 0x1B;
            d["backspace"] = 0x08; d["back_space"] = 0x08;
            d["delete"] = 0x2E | EXT; d["del"] = 0x2E | EXT; d["insert"] = 0x2D | EXT; d["ins"] = 0x2D | EXT;
            d["home"] = 0x24 | EXT; d["end"] = 0x23 | EXT;
            d["page_up"] = 0x21 | EXT; d["pageup"] = 0x21 | EXT; d["prior"] = 0x21 | EXT; d["pgup"] = 0x21 | EXT;
            d["page_down"] = 0x22 | EXT; d["pagedown"] = 0x22 | EXT; d["next"] = 0x22 | EXT; d["pgdn"] = 0x22 | EXT;
            d["up"] = 0x26 | EXT; d["down"] = 0x28 | EXT; d["left"] = 0x25 | EXT; d["right"] = 0x27 | EXT;
            d["space"] = 0x20; d["caps_lock"] = 0x14; d["capslock"] = 0x14;
            d["num_lock"] = 0x90 | EXT; d["numlock"] = 0x90 | EXT; d["scroll_lock"] = 0x91;
            d["print"] = 0x2C | EXT; d["printscreen"] = 0x2C | EXT; d["print_screen"] = 0x2C | EXT; d["sys_req"] = 0x2C | EXT;
            d["pause"] = 0x13; d["break"] = 0x13;
            d["menu"] = 0x5D | EXT; d["apps"] = 0x5D | EXT; d["context_menu"] = 0x5D | EXT;
            for (int i = 1; i <= 24; i++) d["f" + i.ToString(CultureInfo.InvariantCulture)] = 0x70 + i - 1;
            for (int i = 0; i <= 9; i++)
            {
                string n = i.ToString(CultureInfo.InvariantCulture);
                d["kp_" + n] = 0x60 + i; d["numpad_" + n] = 0x60 + i; d["numpad" + n] = 0x60 + i;
            }
            string[][] keypad = {
                new string[] { "add", "6B" }, new string[] { "subtract", "6D" }, new string[] { "multiply", "6A" },
                new string[] { "divide", "1006F" }, new string[] { "decimal", "6E" }, new string[] { "separator", "6C" }
            };
            foreach (string[] k in keypad)
            {
                int vk = int.Parse(k[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                d["kp_" + k[0]] = vk; d["numpad_" + k[0]] = vk;
            }
            d["kp_home"] = 0x24; d["kp_end"] = 0x23; d["kp_up"] = 0x26; d["kp_down"] = 0x28;
            d["kp_left"] = 0x25; d["kp_right"] = 0x27; d["kp_prior"] = 0x21; d["kp_page_up"] = 0x21;
            d["kp_next"] = 0x22; d["kp_page_down"] = 0x22; d["kp_insert"] = 0x2D; d["kp_delete"] = 0x2E;
            d["kp_begin"] = 0x0C;
            return d;
        }

        private static Dictionary<string, char> BuildPunctuation()
        {
            Dictionary<string, char> d = new Dictionary<string, char>(StringComparer.OrdinalIgnoreCase);
            d["period"] = '.'; d["dot"] = '.'; d["comma"] = ','; d["slash"] = '/'; d["backslash"] = '\\';
            d["minus"] = '-'; d["hyphen"] = '-'; d["equal"] = '='; d["equals"] = '='; d["plus"] = '+';
            d["semicolon"] = ';'; d["colon"] = ':'; d["apostrophe"] = '\''; d["quoteright"] = '\'';
            d["quotedbl"] = '"'; d["grave"] = '`'; d["quoteleft"] = '`'; d["asciitilde"] = '~'; d["tilde"] = '~';
            d["bracketleft"] = '['; d["bracketright"] = ']'; d["braceleft"] = '{'; d["braceright"] = '}';
            d["less"] = '<'; d["greater"] = '>'; d["question"] = '?'; d["exclam"] = '!'; d["at"] = '@';
            d["numbersign"] = '#'; d["dollar"] = '$'; d["percent"] = '%'; d["asciicircum"] = '^';
            d["ampersand"] = '&'; d["asterisk"] = '*'; d["parenleft"] = '('; d["parenright"] = ')';
            d["underscore"] = '_'; d["bar"] = '|';
            return d;
        }

        private static KeySpec Vk(int code, string label)
        {
            KeySpec k = new KeySpec();
            k.Vk = (ushort)(code & 0xFFFF);
            k.Extended = (code & EXT) != 0;
            k.Label = label;
            return k;
        }

        /// <summary>Parses a chord; layout is the target thread's keyboard layout (for punctuation).</summary>
        public static Chord Parse(string text, IntPtr layout)
        {
            Chord c = new Chord();
            string raw = (text ?? "").Trim();
            if (raw.Length == 0) { c.Error = "No key given."; return c; }

            // Whitespace around '+' is ignored; "Ctrl++" (or a lone "+") means the '+' key itself.
            raw = Regex.Replace(raw, "\\s*\\+\\s*", "+");
            bool plusKey = false;
            if (raw == "+") { plusKey = true; raw = ""; }
            else if (raw.EndsWith("++", StringComparison.Ordinal)) { plusKey = true; raw = raw.Substring(0, raw.Length - 2); }
            List<string> tokens = new List<string>();
            foreach (string part in raw.Split('+'))
            {
                string t = part.Trim();
                if (t.Length > 0) tokens.Add(t);
            }
            if (plusKey) tokens.Add("+");
            if (tokens.Count == 0) { c.Error = "No key given."; return c; }

            bool hasShift = false, hasCtrl = false, hasAlt = false;
            for (int i = 0; i < tokens.Count; i++)
            {
                string t = tokens[i];
                string lower = t.ToLowerInvariant();
                foreach (string f in Forbidden)
                {
                    if (lower == f)
                    {
                        c.Refusal = "The Windows key (" + t + ") is never pressed by computer use.";
                        return c;
                    }
                }
                KeySpec mod = Modifier(lower);
                bool last = i == tokens.Count - 1;
                if (mod != null && !last)
                {
                    if (mod.Vk == 0x10 || mod.Vk == 0xA1) hasShift = true;
                    if (mod.Vk == 0x11 || mod.Vk == 0xA3) hasCtrl = true;
                    if (mod.Vk == 0x12 || mod.Vk == 0xA5) hasAlt = true;
                    c.Modifiers.Add(mod);
                    continue;
                }
                if (!last)
                {
                    c.Error = "'" + t + "' is not a modifier; only the last key of a chord may be an ordinary key.";
                    return c;
                }
                if (mod != null) { c.Key = mod; break; }

                int code;
                if (Named.TryGetValue(lower, out code)) { c.Key = Vk(code, t); break; }
                if (lower == "iso_left_tab")
                {
                    if (!hasShift) c.Modifiers.Add(Vk(0x10, "Shift"));
                    c.Key = Vk(0x09, "Tab");
                    break;
                }
                char ch;
                if (Punctuation.TryGetValue(lower, out ch)) { }
                else if (t.Length == 1) ch = t[0];
                else if (t.Length == 2 && char.IsSurrogatePair(t[0], t[1])) { c.Error = "Use type for '" + t + "'."; return c; }
                else { c.Error = "Unknown key name '" + t + "'. See docs/reference.md for key names."; return c; }

                bool withModifiers = c.Modifiers.Count > 0;
                if (ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z')
                {
                    // Letters in a chord are case-insensitive (Ctrl+A is Ctrl+A); alone, a capital needs Shift.
                    if (!withModifiers && ch >= 'A' && ch <= 'Z' && !hasShift) c.Modifiers.Add(Vk(0x10, "Shift"));
                    c.Key = Vk(char.ToUpperInvariant(ch), t);
                    break;
                }
                if (ch >= '0' && ch <= '9') { c.Key = Vk(ch, t); break; }

                short scan = Native.VkKeyScanEx(ch, layout);
                if (scan == -1 || (scan & 0xFF) == 0xFF)
                {
                    if (withModifiers) { c.Error = "'" + t + "' has no key on the current keyboard layout."; return c; }
                    KeySpec u = new KeySpec(); u.Unicode = true; u.Char = ch; u.Label = t;
                    c.Key = u;
                    break;
                }
                int state = (scan >> 8) & 0xFF;
                if ((state & 1) != 0 && !hasShift) c.Modifiers.Add(Vk(0x10, "Shift"));
                if ((state & 2) != 0 && !hasCtrl) c.Modifiers.Add(Vk(0x11, "Ctrl"));
                if ((state & 4) != 0 && !hasAlt) c.Modifiers.Add(Vk(0x12, "Alt"));
                c.Key = Vk(scan & 0xFF, t);
                break;
            }
            if (c.Key == null) { c.Error = "The chord has no key."; return c; }

            // Task Manager and the secure attention sequence are off limits.
            bool ctrl = false, shift = false, alt = false;
            foreach (KeySpec m in c.Modifiers)
            {
                if (m.Vk == 0x11 || m.Vk == 0xA3) ctrl = true;
                if (m.Vk == 0x10 || m.Vk == 0xA1) shift = true;
                if (m.Vk == 0x12 || m.Vk == 0xA5) alt = true;
            }
            if (ctrl && shift && !c.Key.Unicode && c.Key.Vk == 0x1B)
                c.Refusal = "Ctrl+Shift+Escape opens Task Manager, which computer use never drives.";
            if (ctrl && alt && !c.Key.Unicode && (c.Key.Vk == 0x2E))
                c.Refusal = "Ctrl+Alt+Delete is reserved for the person at the computer.";
            return c;
        }

        private static KeySpec Modifier(string lower)
        {
            switch (lower)
            {
                case "ctrl": case "control": case "control_l": case "ctrl_l": case "lctrl": case "lcontrol":
                    return Vk(0x11, "Ctrl");
                case "control_r": case "ctrl_r": case "rctrl": case "rcontrol":
                    return Vk(0xA3 | EXT, "Ctrl_R");
                case "alt": case "alt_l": case "lalt": case "option": case "opt":
                    return Vk(0x12, "Alt");
                case "alt_r": case "ralt": case "altgr": case "iso_level3_shift":
                    return Vk(0xA5 | EXT, "Alt_R");
                case "shift": case "shift_l": case "lshift":
                    return Vk(0x10, "Shift");
                case "shift_r": case "rshift":
                    return Vk(0xA1, "Shift_R");
            }
            return null;
        }

        /// <summary>Presses a parsed chord: modifiers down, key down and up, modifiers up.</summary>
        public static bool Press(Chord c)
        {
            bool ok = true;
            foreach (KeySpec m in c.Modifiers) { ok &= SendKey(m, false); Thread.Sleep(8); }
            if (c.Key.Unicode) ok &= SendChar(c.Key.Char);
            else
            {
                ok &= SendKey(c.Key, false);
                Thread.Sleep(20);
                ok &= SendKey(c.Key, true);
            }
            for (int i = c.Modifiers.Count - 1; i >= 0; i--) { Thread.Sleep(8); ok &= SendKey(c.Modifiers[i], true); }
            return ok;
        }

        private static bool SendKey(KeySpec k, bool up)
        {
            Native.INPUT[] input = new Native.INPUT[1];
            input[0].type = 1; // INPUT_KEYBOARD
            input[0].u.ki.wVk = k.Vk;
            input[0].u.ki.wScan = (ushort)Native.MapVirtualKey(k.Vk, 0);
            uint flags = 0;
            if (k.Extended) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            if (up) flags |= Native.KEYEVENTF_KEYUP;
            input[0].u.ki.dwFlags = flags;
            return Native.SendInput(1, input, Marshal.SizeOf(typeof(Native.INPUT))) == 1;
        }

        /// <summary>One UTF-16 unit (or a surrogate pair, sent together) as KEYEVENTF_UNICODE.</summary>
        private static bool SendUnits(char[] units)
        {
            Native.INPUT[] input = new Native.INPUT[units.Length * 2];
            for (int i = 0; i < units.Length; i++)
            {
                input[i * 2].type = 1;
                input[i * 2].u.ki.wScan = units[i];
                input[i * 2].u.ki.dwFlags = Native.KEYEVENTF_UNICODE;
                input[i * 2 + 1].type = 1;
                input[i * 2 + 1].u.ki.wScan = units[i];
                input[i * 2 + 1].u.ki.dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP;
            }
            return Native.SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Native.INPUT))) == input.Length;
        }

        private static bool SendChar(char ch) { return SendUnits(new char[] { ch }); }

        /// <summary>
        /// Types literal text. Newlines (CR, LF or CRLF) become Enter presses. Between chunks the
        /// check callback may stop the typing by returning a reason; the reason is returned with
        /// how many characters were already typed. Returns null when everything was typed.
        /// </summary>
        public static string Type(string text, int delayMs, int chunk, Func<string> check, out int typed)
        {
            typed = 0;
            KeySpec enter = Vk(0x0D, "Return");
            int sinceCheck = 0;
            for (int i = 0; i < text.Length; i++)
            {
                if (sinceCheck >= chunk && check != null)
                {
                    // PowerShell hands back "" for $null, so an empty reason means carry on.
                    string reason = check();
                    if (!string.IsNullOrEmpty(reason)) return reason;
                    sinceCheck = 0;
                }
                char ch = text[i];
                bool ok;
                if (ch == '\r' || ch == '\n')
                {
                    if (ch == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                    ok = SendKey(enter, false) & SendKey(enter, true);
                }
                else if (char.IsHighSurrogate(ch) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                {
                    ok = SendUnits(new char[] { ch, text[i + 1] });
                    i++;
                }
                else ok = SendChar(ch);
                if (!ok) return "Windows refused the keyboard input (error " + Marshal.GetLastWin32Error() + ").";
                typed++;
                sinceCheck++;
                if (delayMs > 0) Thread.Sleep(delayMs);
            }
            return null;
        }
    }

    /// <summary>Small, careful file helpers shared by the CLI and the overlay.</summary>
    public static class FileUtil
    {
        public static readonly Encoding Utf8 = new UTF8Encoding(false);

        /// <summary>Reads a file other processes may be rewriting; null when missing or locked. A BOM is dropped.</summary>
        public static string ReadShared(string path)
        {
            for (int attempt = 0; attempt < 4; attempt++)
            {
                try
                {
                    using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete))
                    using (StreamReader reader = new StreamReader(fs, Utf8, true))
                    {
                        return reader.ReadToEnd();
                    }
                }
                catch (FileNotFoundException) { return null; }
                catch (DirectoryNotFoundException) { return null; }
                catch (IOException) { Thread.Sleep(10); }
                catch (UnauthorizedAccessException) { Thread.Sleep(10); }
            }
            return null;
        }

        /// <summary>
        /// Writes UTF-8 without a BOM to a temp file, then renames it over the target, so a reader
        /// (the overlay, the desktop app) never sees a torn or half-written file.
        /// </summary>
        public static bool WriteAtomic(string path, string text)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string tmp = path + "." + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                + "." + Guid.NewGuid().ToString("N").Substring(0, 6) + ".tmp";
            File.WriteAllText(tmp, text, Utf8);
            for (int attempt = 0; attempt < 40; attempt++)
            {
                if (Native.MoveFileEx(tmp, path, 0x1 | 0x8)) return true; // REPLACE_EXISTING | WRITE_THROUGH
                Thread.Sleep(15);
            }
            try
            {
                File.Copy(tmp, path, true);
                return true;
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
            finally
            {
                try { File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        /// <summary>Appends one line; several processes may append at once.</summary>
        public static bool AppendLine(string path, string line)
        {
            byte[] bytes = Utf8.GetBytes(line + "\n");
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            for (int attempt = 0; attempt < 25; attempt++)
            {
                try
                {
                    using (FileStream fs = new FileStream(path, FileMode.Append, FileAccess.Write,
                        FileShare.ReadWrite | FileShare.Delete))
                    {
                        fs.Write(bytes, 0, bytes.Length);
                    }
                    return true;
                }
                catch (IOException) { Thread.Sleep(10); }
                catch (UnauthorizedAccessException) { Thread.Sleep(10); }
            }
            return false;
        }

        /// <summary>Keeps a line log bounded: past maxLines, only the newest keepLines stay.</summary>
        public static void TrimLines(string path, long checkAboveBytes, int maxLines, int keepLines)
        {
            try
            {
                FileInfo fi = new FileInfo(path);
                if (!fi.Exists || fi.Length < checkAboveBytes) return;
                string text = ReadShared(path);
                if (text == null) return;
                string[] lines = text.Split(new char[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
                if (lines.Length <= maxLines) return;
                StringBuilder sb = new StringBuilder();
                for (int i = Math.Max(0, lines.Length - keepLines); i < lines.Length; i++)
                    sb.Append(lines[i].TrimEnd('\r')).Append('\n');
                WriteAtomic(path, sb.ToString());
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        /// <summary>Deletes all but the newest `keep` files matching pattern in dir.</summary>
        public static void Prune(string dir, string pattern, int keep)
        {
            try
            {
                if (!Directory.Exists(dir)) return;
                List<FileInfo> files = new List<FileInfo>(new DirectoryInfo(dir).GetFiles(pattern));
                if (files.Count <= keep) return;
                files.Sort(delegate (FileInfo a, FileInfo b) { return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc); });
                for (int i = keep; i < files.Count; i++)
                {
                    try { files[i].Delete(); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>Just enough JSON: writing values, and reading the flat files this tool writes.</summary>
    public static class Json
    {
        public static string Q(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        // Non-ASCII is escaped, so every file this tool writes is plain ASCII.
                        if (ch < ' ' || ch > '~')
                            sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string N(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
            return v.ToString("0.####", CultureInfo.InvariantCulture);
        }

        public static string N(long v) { return v.ToString(CultureInfo.InvariantCulture); }

        public static string B(bool b) { return b ? "true" : "false"; }

        public static string Rect(Rectangle r)
        {
            return "{\"x\": " + N(r.X) + ", \"y\": " + N(r.Y) + ", \"width\": " + N(r.Width)
                + ", \"height\": " + N(r.Height) + "}";
        }

        public static string Str(string json, string key)
        {
            if (json == null) return null;
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Unescape(m.Groups[1].Value) : null;
        }

        public static bool? Bool(string json, string key)
        {
            if (json == null) return null;
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(true|false)", RegexOptions.IgnoreCase);
            if (!m.Success) return null;
            return m.Groups[1].Value.ToLowerInvariant() == "true";
        }

        public static long? Int(string json, string key)
        {
            if (json == null) return null;
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?[0-9]+)(?![0-9.eE])");
            if (!m.Success) return null;
            long v;
            if (!long.TryParse(m.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) return null;
            return v;
        }

        /// <summary>A flat array of strings, e.g. "allowedProcesses": ["notepad", "mspaint"].</summary>
        public static List<string> StrArray(string json, string key)
        {
            List<string> list = new List<string>();
            if (json == null) return list;
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\\[(.*?)\\]", RegexOptions.Singleline);
            if (!m.Success) return list;
            foreach (Match s in Regex.Matches(m.Groups[1].Value, "\"((?:[^\"\\\\]|\\\\.)*)\""))
                list.Add(Unescape(s.Groups[1].Value));
            return list;
        }

        public static string Unescape(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                if (s[i] != '\\' || i + 1 >= s.Length) { sb.Append(s[i]); continue; }
                char n = s[++i];
                if (n == 'n') sb.Append('\n');
                else if (n == 't') sb.Append('\t');
                else if (n == 'r') sb.Append('\r');
                else if (n == 'b') sb.Append('\b');
                else if (n == 'f') sb.Append('\f');
                else if (n == 'u' && i + 4 < s.Length)
                {
                    sb.Append((char)int.Parse(s.Substring(i + 1, 4), NumberStyles.HexNumber,
                        CultureInfo.InvariantCulture));
                    i += 4;
                }
                else sb.Append(n);
            }
            return sb.ToString();
        }
    }

    /// <summary>A visible top-level window, in real screen pixels.</summary>
    public class WindowInfo
    {
        public int Order;          // 0 is frontmost
        public long Hwnd;
        public string Title = "";
        public string Process = "";
        public int Pid;
        public string ClassName = "";
        public Rectangle Bounds;   // the visible frame, without the invisible resize border
        public bool Minimized;

        public IntPtr Handle { get { return new IntPtr(Hwnd); } }

        public override string ToString()
        {
            string where = Minimized ? "minimized"
                : string.Format(CultureInfo.InvariantCulture, "x={0} y={1} width={2} height={3}",
                    Bounds.Left, Bounds.Top, Bounds.Width, Bounds.Height);
            return string.Format(CultureInfo.InvariantCulture, "{0,2}  hwnd={1}  {2}  [{3}]  {4}",
                Order, Hwnd, where, Process, Title);
        }

        public string ToJson()
        {
            return "{\"hwnd\": " + Json.N(Hwnd) + ", \"title\": " + Json.Q(Title)
                + ", \"process\": " + Json.Q(Process) + ", \"pid\": " + Json.N(Pid)
                + ", \"className\": " + Json.Q(ClassName) + ", \"order\": " + Json.N(Order)
                + ", \"minimized\": " + Json.B(Minimized) + ", \"bounds\": " + Json.Rect(Bounds) + "}";
        }
    }

    /// <summary>An app with visible windows: one process.</summary>
    public class AppInfo
    {
        public string Process = "";
        public int Pid;
        public string Path = "";
        public List<WindowInfo> Windows = new List<WindowInfo>();

        public string ToJson()
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"process\": ").Append(Json.Q(Process)).Append(", \"pid\": ").Append(Json.N(Pid))
              .Append(", \"path\": ").Append(Json.Q(Path)).Append(", \"windows\": [");
            for (int i = 0; i < Windows.Count; i++)
            {
                if (i > 0) sb.Append(", ");
                sb.Append(Windows[i].ToJson());
            }
            sb.Append("]}");
            return sb.ToString();
        }
    }

    /// <summary>Finding, describing and activating top-level windows.</summary>
    public static class WindowOps
    {
        private static readonly Dictionary<uint, string> Names = new Dictionary<uint, string>();

        public static string ProcessName(uint pid)
        {
            string name;
            lock (Names)
            {
                if (Names.TryGetValue(pid, out name)) return name;
            }
            name = "";
            try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            lock (Names)
            {
                if (Names.Count > 300) Names.Clear();
                Names[pid] = name;
            }
            return name;
        }

        public static string ProcessPath(uint pid)
        {
            IntPtr h = Native.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { Native.CloseHandle(h); }
        }

        public static uint Pid(IntPtr hwnd)
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            return pid;
        }

        public static string Title(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(512);
            Native.GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        public static string ClassOf(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(256);
            Native.GetClassName(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        /// <summary>The visible frame (DWM extended frame bounds), falling back to the window rect.</summary>
        public static Rectangle Bounds(IntPtr hwnd)
        {
            Native.RECT r;
            try
            {
                if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out r,
                    Marshal.SizeOf(typeof(Native.RECT))) == 0 && r.Right > r.Left && r.Bottom > r.Top)
                    return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
            }
            catch (DllNotFoundException) { }
            Native.GetWindowRect(hwnd, out r);
            return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        }

        public static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked;
            try
            {
                return Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
            }
            catch (DllNotFoundException) { return false; }
        }

        public static WindowInfo Info(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return null;
            WindowInfo w = new WindowInfo();
            w.Hwnd = hwnd.ToInt64();
            w.Title = Title(hwnd);
            w.ClassName = ClassOf(hwnd);
            uint pid = Pid(hwnd);
            w.Pid = (int)pid;
            w.Process = ProcessName(pid);
            w.Minimized = Native.IsIconic(hwnd);
            w.Bounds = Bounds(hwnd);
            w.Order = -1;
            return w;
        }

        public static bool LooksLikeHandle(string spec)
        {
            return !string.IsNullOrEmpty(spec) && Regex.IsMatch(spec.Trim(), "^(0x[0-9a-fA-F]+|[0-9]+)$");
        }

        /// <summary>A window handle written as decimal or 0x-hex, if it names a live window.</summary>
        public static IntPtr ParseHandle(string spec)
        {
            if (!LooksLikeHandle(spec)) return IntPtr.Zero;
            string s = spec.Trim();
            long v;
            bool ok = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? long.TryParse(s.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)
                : long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v);
            if (!ok || v <= 0) return IntPtr.Zero;
            IntPtr h = new IntPtr(v);
            return Native.IsWindow(h) ? h : IntPtr.Zero;
        }

        /// <summary>
        /// A window from a handle, or the frontmost visible window whose title or process name
        /// contains the text (an on-screen one first; minimized ones only when allowed).
        /// </summary>
        public static WindowInfo Resolve(string spec, bool allowMinimized)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            IntPtr h = ParseHandle(spec);
            if (h != IntPtr.Zero) return Info(h);
            List<WindowInfo> found = ScreenTools.Windows(spec);
            // An exact title match beats a substring match.
            foreach (WindowInfo w in found)
                if (!w.Minimized && string.Equals(w.Title, spec, StringComparison.OrdinalIgnoreCase)) return w;
            foreach (WindowInfo w in found) if (!w.Minimized) return w;
            if (allowMinimized) foreach (WindowInfo w in found) return w;
            return null;
        }

        /// <summary>The top-level window under a screen pixel.</summary>
        public static IntPtr RootAt(int x, int y)
        {
            Native.POINT p = new Native.POINT(); p.X = x; p.Y = y;
            IntPtr hwnd = Native.WindowFromPoint(p);
            return hwnd == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(hwnd, Native.GA_ROOT);
        }

        /// <summary>
        /// The process that really owns a window's content. Store-style apps live inside an
        /// ApplicationFrameHost frame; their content window belongs to the app's own process.
        /// </summary>
        public static string EffectiveProcess(IntPtr root)
        {
            uint pid = Pid(root);
            string name = ProcessName(pid);
            if (!string.Equals(name, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) return name;
            string inner = name;
            Native.EnumChildWindows(root, delegate (IntPtr child, IntPtr l)
            {
                uint cpid = Pid(child);
                if (cpid != pid && cpid != 0)
                {
                    inner = ProcessName(cpid);
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return inner;
        }

        /// <summary>True when other is the target, is owned by it, or belongs to the same process (a menu or popup).</summary>
        public static bool SameApp(IntPtr target, IntPtr other)
        {
            if (target == IntPtr.Zero || other == IntPtr.Zero) return false;
            if (other == target) return true;
            IntPtr o = other;
            for (int i = 0; i < 12 && o != IntPtr.Zero; i++)
            {
                o = Native.GetWindow(o, Native.GW_OWNER);
                if (o == target) return true;
            }
            return Pid(target) == Pid(other);
        }

        public static string Describe(IntPtr root)
        {
            if (root == IntPtr.Zero) return "";
            string title = Title(root);
            string process = EffectiveProcess(root);
            if (process.Length == 0) return title;
            return title.Length > 0 ? title + " (" + process + ")" : process;
        }

        /// <summary>Whether the window at the target pixel is the one the agent named with -Window.</summary>
        public static bool Matches(string spec, IntPtr root)
        {
            if (string.IsNullOrEmpty(spec)) return true;
            IntPtr target = ParseHandle(spec);
            if (target != IntPtr.Zero) return SameApp(target, root);
            if (root == IntPtr.Zero) return false;
            string title = Title(root);
            string process = ProcessName(Pid(root));
            string inner = EffectiveProcess(root);
            return title.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0
                || process.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0
                || inner.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>True when the foreground window is the target or one of its dialogs.</summary>
        public static bool IsForeground(IntPtr target)
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;
            if (fg == target) return true;
            IntPtr o = fg;
            for (int i = 0; i < 12 && o != IntPtr.Zero; i++)
            {
                o = Native.GetWindow(o, Native.GW_OWNER);
                if (o == target) return true;
            }
            return false;
        }

        private static bool WaitForeground(IntPtr target, int ms)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                if (IsForeground(target)) return true;
                Thread.Sleep(20);
            }
            return IsForeground(target);
        }

        private static void TapAlt()
        {
            Chord alt = new Chord();
            KeySpec k = new KeySpec(); k.Vk = 0x12; k.Label = "Alt";
            alt.Key = k;
            Keyboard.Press(alt);
        }

        /// <summary>
        /// Restores a minimized window and brings it to the foreground, escalating through the
        /// usual techniques, because Windows refuses a plain SetForegroundWindow from a process
        /// that does not own the foreground. Returns whether the window ended up in front.
        /// </summary>
        public static bool Activate(IntPtr h, out string how)
        {
            how = "";
            if (!Native.IsWindow(h)) { how = "the window no longer exists"; return false; }
            if (Native.IsIconic(h))
            {
                Native.ShowWindow(h, Native.SW_RESTORE);
                Thread.Sleep(200);
                how = "restored, ";
            }
            if (IsForeground(h)) { how += "already in front"; return true; }

            Native.SetForegroundWindow(h);
            if (WaitForeground(h, 150)) { how += "brought to front"; return true; }

            uint ignored;
            IntPtr fg = Native.GetForegroundWindow();
            uint me = Native.GetCurrentThreadId();
            uint fgThread = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, out ignored);
            uint targetThread = Native.GetWindowThreadProcessId(h, out ignored);
            bool a1 = fgThread != 0 && fgThread != me && Native.AttachThreadInput(me, fgThread, true);
            bool a2 = targetThread != 0 && targetThread != me && targetThread != fgThread
                && Native.AttachThreadInput(me, targetThread, true);
            try
            {
                Native.BringWindowToTop(h);
                Native.ShowWindow(h, Native.SW_SHOW);
                Native.SetForegroundWindow(h);
            }
            finally
            {
                if (a1) Native.AttachThreadInput(me, fgThread, false);
                if (a2) Native.AttachThreadInput(me, targetThread, false);
            }
            if (WaitForeground(h, 250)) { how += "brought to front (attached input)"; return true; }

            // Two Alt taps make this process the last to receive input, and cancel each other's
            // menu activation in whatever window has the focus.
            TapAlt();
            TapAlt();
            Native.SetForegroundWindow(h);
            if (WaitForeground(h, 300)) { how += "brought to front (after Alt tap)"; return true; }

            Native.SwitchToThisWindow(h, true);
            if (WaitForeground(h, 400)) { how += "brought to front (switched)"; return true; }
            how += "Windows kept '" + Describe(Native.GetForegroundWindow()) + "' in front";
            return false;
        }
    }

    /// <summary>How an agent sees the screen: windows, apps, and real-pixel screenshots.</summary>
    public static class ScreenTools
    {
        /// <summary>Visible, titled top-level windows, front to back; match filters on title or process name.</summary>
        public static List<WindowInfo> Windows(string match)
        {
            List<WindowInfo> found = new List<WindowInfo>();
            int order = 0;
            Native.EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                string title = WindowOps.Title(h);
                if (title.Length == 0) return true;
                bool minimized = Native.IsIconic(h);
                Rectangle bounds = WindowOps.Bounds(h);
                if (!minimized && (bounds.Width <= 0 || bounds.Height <= 0)) return true;
                // Cloaked windows (suspended Store apps, other virtual desktops) are not on screen.
                if (WindowOps.IsCloaked(h)) return true;
                uint pid = WindowOps.Pid(h);
                WindowInfo w = new WindowInfo();
                w.Order = order++;
                w.Hwnd = h.ToInt64();
                w.Title = title;
                w.Pid = (int)pid;
                w.Process = WindowOps.ProcessName(pid);
                w.ClassName = WindowOps.ClassOf(h);
                w.Bounds = bounds;
                w.Minimized = minimized;
                if (string.IsNullOrEmpty(match)
                    || w.Title.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0
                    || w.Process.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0
                    || w.Hwnd.ToString(CultureInfo.InvariantCulture) == match)
                    found.Add(w);
                return true;
            }, IntPtr.Zero);
            return found;
        }

        /// <summary>Running apps that own visible top-level windows, in front-to-back order of their first window.</summary>
        public static List<AppInfo> Apps(string match)
        {
            List<AppInfo> apps = new List<AppInfo>();
            Dictionary<int, AppInfo> byPid = new Dictionary<int, AppInfo>();
            foreach (WindowInfo w in Windows(""))
            {
                AppInfo app;
                if (!byPid.TryGetValue(w.Pid, out app))
                {
                    app = new AppInfo();
                    app.Pid = w.Pid;
                    app.Process = w.Process;
                    app.Path = WindowOps.ProcessPath((uint)w.Pid);
                    byPid[w.Pid] = app;
                    apps.Add(app);
                }
                app.Windows.Add(w);
            }
            if (string.IsNullOrEmpty(match)) return apps;
            List<AppInfo> filtered = new List<AppInfo>();
            foreach (AppInfo a in apps)
            {
                bool hit = a.Process.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0
                    || a.Path.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0;
                foreach (WindowInfo w in a.Windows)
                    if (w.Title.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) hit = true;
                if (hit) filtered.Add(a);
            }
            return filtered;
        }

        /// <summary>A copy of what is on screen in a rectangle (the overlay excludes itself from it).</summary>
        public static Bitmap GrabScreen(Rectangle r)
        {
            Bitmap shot = new Bitmap(Math.Max(1, r.Width), Math.Max(1, r.Height), PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(shot))
            {
                IntPtr dst = g.GetHdc();
                IntPtr screen = Native.GetDC(IntPtr.Zero);
                Native.BitBlt(dst, 0, 0, r.Width, r.Height, screen, r.X, r.Y, 0x00CC0020); // SRCCOPY
                Native.ReleaseDC(IntPtr.Zero, screen);
                g.ReleaseHdc(dst);
            }
            return shot;
        }

        /// <summary>
        /// The window's own rendering via PrintWindow(PW_RENDERFULLCONTENT): correct even when
        /// other windows cover it. A blank result (some apps do not render for PrintWindow) falls
        /// back to a copy of the screen, which shows whatever is in front of the window.
        /// </summary>
        public static Bitmap GrabWindow(IntPtr h, Rectangle frame, out string method)
        {
            method = "printwindow";
            Native.RECT wr;
            Native.GetWindowRect(h, out wr);
            int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
            if (ww > 0 && wh > 0 && ww < 16384 && wh < 16384)
            {
                using (Bitmap full = new Bitmap(ww, wh, PixelFormat.Format32bppRgb))
                {
                    bool ok;
                    using (Graphics g = Graphics.FromImage(full))
                    {
                        IntPtr hdc = g.GetHdc();
                        try { ok = Native.PrintWindow(h, hdc, Native.PW_RENDERFULLCONTENT); }
                        finally { g.ReleaseHdc(hdc); }
                    }
                    if (ok)
                    {
                        Rectangle crop = new Rectangle(frame.Left - wr.Left, frame.Top - wr.Top, frame.Width, frame.Height);
                        crop.Intersect(new Rectangle(0, 0, ww, wh));
                        if (crop.Width > 0 && crop.Height > 0)
                        {
                            Bitmap cut = full.Clone(crop, PixelFormat.Format24bppRgb);
                            if (!IsBlank(cut)) return cut;
                            cut.Dispose();
                        }
                    }
                }
            }
            method = "screen";
            return GrabScreen(frame);
        }

        /// <summary>True when every sampled pixel has the same colour: a capture that rendered nothing.</summary>
        public static bool IsBlank(Bitmap bmp)
        {
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
                ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int first = -1;
                int stepsX = Math.Min(64, bmp.Width), stepsY = Math.Min(64, bmp.Height);
                byte[] px = new byte[3];
                for (int sy = 0; sy < stepsY; sy++)
                {
                    int y = (int)((long)sy * (bmp.Height - 1) / Math.Max(1, stepsY - 1));
                    for (int sx = 0; sx < stepsX; sx++)
                    {
                        int x = (int)((long)sx * (bmp.Width - 1) / Math.Max(1, stepsX - 1));
                        Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride + x * 3), px, 0, 3);
                        int c = px[0] | (px[1] << 8) | (px[2] << 16);
                        if (first < 0) first = c;
                        else if (c != first) return false;
                    }
                }
                return true;
            }
            finally { bmp.UnlockBits(data); }
        }

        /// <summary>The zoom that keeps an image within the size vision models take without resampling.</summary>
        public static double AutoZoom(int width, int height, int maxEdge, double maxPixels)
        {
            double z = 1.0;
            int edge = Math.Max(width, height);
            if (edge > maxEdge) z = Math.Min(z, (double)maxEdge / edge);
            double pixels = (double)width * height;
            if (pixels * z * z > maxPixels) z = Math.Min(z, Math.Sqrt(maxPixels / pixels));
            // Round down to 4 places so width*zoom never rounds past the limit.
            return Math.Floor(z * 10000) / 10000.0;
        }

        /// <summary>Saves a PNG, scaled by zoom; returns the saved size.</summary>
        public static Size SavePng(Bitmap shot, string path, double zoom)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            if (Math.Abs(zoom - 1.0) < 1e-9)
            {
                shot.Save(path, ImageFormat.Png);
                return shot.Size;
            }
            int zw = Math.Max(1, (int)Math.Round(shot.Width * zoom));
            int zh = Math.Max(1, (int)Math.Round(shot.Height * zoom));
            using (Bitmap scaled = new Bitmap(zw, zh, PixelFormat.Format24bppRgb))
            using (Graphics g = Graphics.FromImage(scaled))
            using (ImageAttributes attrs = new ImageAttributes())
            {
                attrs.SetWrapMode(WrapMode.TileFlipXY);
                g.InterpolationMode = zoom < 1 ? InterpolationMode.HighQualityBicubic : InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(shot, new Rectangle(0, 0, zw, zh), 0, 0, shot.Width, shot.Height, GraphicsUnit.Pixel, attrs);
                scaled.Save(path, ImageFormat.Png);
            }
            return new Size(zw, zh);
        }

        /// <summary>Saves a PNG of a screen region (the whole primary screen when width is 0).</summary>
        public static string Capture(string path, int x, int y, int width, int height, double zoom)
        {
            if (width <= 0 || height <= 0)
            {
                Rectangle s = Screen.PrimaryScreen.Bounds;
                x = s.Left; y = s.Top; width = s.Width; height = s.Height;
            }
            Size saved;
            using (Bitmap shot = GrabScreen(new Rectangle(x, y, width, height)))
            {
                saved = SavePng(shot, path, zoom);
            }
            return string.Format(CultureInfo.InvariantCulture,
                "saved {0}  origin x={1} y={2}  size {3}x{4}  zoom {5}  (image {6}x{7})",
                path, x, y, width, height, zoom, saved.Width, saved.Height);
        }

        /// <summary>The primary monitor, in real pixels (PowerShell has not loaded WinForms itself).</summary>
        public static Rectangle PrimaryBounds()
        {
            return Screen.PrimaryScreen.Bounds;
        }

        /// <summary>The bounding box of all monitors.</summary>
        public static Rectangle VirtualScreen()
        {
            return new Rectangle(Native.GetSystemMetrics(76), Native.GetSystemMetrics(77),
                Native.GetSystemMetrics(78), Native.GetSystemMetrics(79));
        }

        public static bool OnSomeScreen(int x, int y)
        {
            foreach (Screen s in Screen.AllScreens)
                if (s.Bounds.Contains(x, y)) return true;
            return false;
        }
    }

    /// <summary>
    /// Which apps computer use may drive: a built-in deny list that always applies, plus the
    /// user's config.json ({"allowedProcesses": [...], "deniedProcesses": [...]}).
    /// </summary>
    public static class Policy
    {
        public static readonly string[] BuiltInDenied = {
            // Terminals and shells: an agent must never run commands through the UI.
            "WindowsTerminal", "cmd", "powershell", "pwsh", "conhost", "OpenConsole", "wt",
            "powershell_ise", "mintty", "ConEmu", "ConEmu64", "alacritty", "wezterm-gui",
            // The lock screen, UAC, credential prompts, security and system tools.
            "LockApp", "consent", "CredentialUIBroker", "SecHealthUI", "SecurityHealthSystray",
            "Taskmgr", "regedit", "mmc",
            // Password managers.
            "1Password", "KeePass", "KeePassXC", "Bitwarden",
            // Agent hosts: an agent must not drive itself or another agent.
            "Agent Task Center", "Codex", "ChatGPT", "claude"
        };

        private static string _configPath;
        private static DateTime _stamp = DateTime.MinValue;
        private static long _length = -1;
        private static List<string> _allow = new List<string>();
        private static List<string> _deny = new List<string>();

        public static void Configure(string stateDir)
        {
            _configPath = Path.Combine(stateDir, "config.json");
            _stamp = DateTime.MinValue;
            _length = -1;
        }

        public static string ConfigPath { get { return _configPath ?? ""; } }
        public static List<string> Allowed { get { Reload(); return new List<string>(_allow); } }
        public static List<string> Denied { get { Reload(); return new List<string>(_deny); } }

        public static string Normalize(string name)
        {
            string n = (name ?? "").Trim();
            if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
            return n;
        }

        private static void Reload()
        {
            if (_configPath == null) return;
            FileInfo fi = new FileInfo(_configPath);
            if (!fi.Exists)
            {
                _allow = new List<string>(); _deny = new List<string>();
                _stamp = DateTime.MinValue; _length = -1;
                return;
            }
            if (fi.LastWriteTimeUtc == _stamp && fi.Length == _length) return;
            string json = FileUtil.ReadShared(_configPath);
            if (json == null) return;
            _stamp = fi.LastWriteTimeUtc;
            _length = fi.Length;
            _allow = Clean(Json.StrArray(json, "allowedProcesses"));
            _deny = Clean(Json.StrArray(json, "deniedProcesses"));
        }

        private static List<string> Clean(List<string> names)
        {
            List<string> list = new List<string>();
            foreach (string n in names)
            {
                string c = Normalize(n);
                if (c.Length > 0) list.Add(c);
            }
            return list;
        }

        private static bool In(IEnumerable<string> list, string name)
        {
            foreach (string s in list)
                if (string.Equals(s, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public static bool IsBuiltInDenied(string name) { return In(BuiltInDenied, Normalize(name)); }

        /// <summary>Null when the process may be driven; otherwise why not.</summary>
        public static string CheckProcess(string name)
        {
            Reload();
            string n = Normalize(name);
            if (In(BuiltInDenied, n))
                return "'" + n + "' is on the built-in deny list: computer use never drives terminals, "
                    + "credential or security tools, the lock screen, or agent apps.";
            if (In(_deny, n))
                return "'" + n + "' is denied by deniedProcesses in " + ConfigPath + ".";
            if (_allow.Count > 0 && !In(_allow, n))
                return "'" + (n.Length > 0 ? n : "unknown process") + "' is not in allowedProcesses in "
                    + ConfigPath + ", and only the apps listed there may be driven.";
            return null;
        }

        /// <summary>Null when the top-level window may be driven; otherwise why not.</summary>
        public static string CheckWindow(IntPtr root)
        {
            if (root == IntPtr.Zero) return null;
            string name = WindowOps.ProcessName(WindowOps.Pid(root));
            string reason = CheckProcess(name);
            if (reason != null) return reason;
            string inner = WindowOps.EffectiveProcess(root);
            if (!string.Equals(inner, name, StringComparison.OrdinalIgnoreCase))
            {
                reason = CheckProcess(inner);
                if (reason != null) return reason;
            }
            // The Run dialog belongs to Explorer, so it is recognised by its class and title.
            if (string.Equals(name, "explorer", StringComparison.OrdinalIgnoreCase)
                && WindowOps.ClassOf(root) == "#32770"
                && string.Equals(WindowOps.Title(root), "Run", StringComparison.OrdinalIgnoreCase))
                return "The Windows Run dialog is never driven by computer use.";
            return null;
        }

        public static string ToJson()
        {
            Reload();
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"configPath\": ").Append(Json.Q(ConfigPath)).Append(", \"builtinDenied\": [");
            for (int i = 0; i < BuiltInDenied.Length; i++) sb.Append(i > 0 ? ", " : "").Append(Json.Q(BuiltInDenied[i]));
            sb.Append("], \"allowedProcesses\": [");
            for (int i = 0; i < _allow.Count; i++) sb.Append(i > 0 ? ", " : "").Append(Json.Q(_allow[i]));
            sb.Append("], \"deniedProcesses\": [");
            for (int i = 0; i < _deny.Count; i++) sb.Append(i > 0 ? ", " : "").Append(Json.Q(_deny[i]));
            sb.Append("]}");
            return sb.ToString();
        }
    }

    /// <summary>One element of a UI Automation snapshot.</summary>
    public class UiNode
    {
        public int Index = -1, Depth;
        public string RuntimeId = "";
        public string ControlType = "", Name = "", AutomationId = "", ClassName = "";
        public string Value;          // null when the element has no value
        public bool ReadOnly;
        public string Toggle;         // On, Off, Indeterminate, or null
        public string Expand;         // Expanded, Collapsed, PartiallyExpanded, LeafNode, or null
        public bool Selected;
        public Rectangle Rect;
        public bool Enabled = true, Focused, Offscreen, Focusable;
        public List<string> Actions = new List<string>();

        private static string Clip(string s, int max)
        {
            if (s == null) return "";
            s = s.Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", " ");
            return s.Length <= max ? s : s.Substring(0, max) + "...";
        }

        public string Line()
        {
            StringBuilder sb = new StringBuilder();
            if (Index >= 0) sb.Append('[').Append(Index.ToString(CultureInfo.InvariantCulture)).Append("] ");
            sb.Append(ControlType.Length > 0 ? ControlType : "Element");
            if (Name.Length > 0) sb.Append(" \"").Append(Clip(Name, 80)).Append('"');
            if (AutomationId.Length > 0 && AutomationId.Length <= 60) sb.Append(" id=").Append(AutomationId);
            if (Value != null) sb.Append(" value=\"").Append(Clip(Value, 80)).Append('"');
            if (Value != null && ReadOnly) sb.Append(" readonly");
            if (Toggle != null) sb.Append(" toggle=").Append(Toggle);
            if (Expand != null && Expand != "LeafNode") sb.Append(' ').Append(Expand.ToLowerInvariant());
            if (Selected) sb.Append(" selected");
            if (!Enabled) sb.Append(" disabled");
            if (Focused) sb.Append(" focused");
            if (Offscreen) sb.Append(" offscreen");
            if (Actions.Count > 0) sb.Append("  actions=").Append(string.Join(",", Actions.ToArray()));
            return sb.ToString();
        }

        public string ToJson()
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"index\": ").Append(Json.N(Index))
              .Append(", \"depth\": ").Append(Json.N(Depth))
              .Append(", \"runtimeId\": ").Append(Json.Q(RuntimeId))
              .Append(", \"controlType\": ").Append(Json.Q(ControlType))
              .Append(", \"name\": ").Append(Json.Q(Name))
              .Append(", \"automationId\": ").Append(Json.Q(AutomationId))
              .Append(", \"className\": ").Append(Json.Q(ClassName))
              .Append(", \"value\": ").Append(Value == null ? "null" : Json.Q(Value.Length > 500 ? Value.Substring(0, 500) : Value))
              .Append(", \"readOnly\": ").Append(Json.B(ReadOnly))
              .Append(", \"toggle\": ").Append(Toggle == null ? "null" : Json.Q(Toggle))
              .Append(", \"expand\": ").Append(Expand == null ? "null" : Json.Q(Expand))
              .Append(", \"selected\": ").Append(Json.B(Selected))
              .Append(", \"enabled\": ").Append(Json.B(Enabled))
              .Append(", \"focused\": ").Append(Json.B(Focused))
              .Append(", \"offscreen\": ").Append(Json.B(Offscreen))
              .Append(", \"actions\": [");
            for (int i = 0; i < Actions.Count; i++) sb.Append(i > 0 ? ", " : "").Append(Json.Q(Actions[i]));
            sb.Append("], \"rect\": ").Append(Json.Rect(Rect)).Append('}');
            return sb.ToString();
        }
    }

    public class UiSnapshot
    {
        public List<UiNode> Nodes = new List<UiNode>();
        public int FocusedIndex = -1;
        public string FocusedLine;
        public string SelectedText;
        public bool Truncated;
        public string Error;
    }

    /// <summary>UI Automation: numbered snapshots of a window, and actions on those elements.</summary>
    public static class Uia
    {
        private static readonly AutomationProperty[] Props = {
            AutomationElement.NameProperty, AutomationElement.ControlTypeProperty,
            AutomationElement.AutomationIdProperty, AutomationElement.ClassNameProperty,
            AutomationElement.BoundingRectangleProperty, AutomationElement.IsEnabledProperty,
            AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsOffscreenProperty,
            AutomationElement.IsKeyboardFocusableProperty, AutomationElement.RuntimeIdProperty,
            AutomationElement.ProcessIdProperty,
            AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
            AutomationElement.IsExpandCollapsePatternAvailableProperty,
            AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
            AutomationElement.IsRangeValuePatternAvailableProperty, AutomationElement.IsScrollItemPatternAvailableProperty,
            ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty,
            RangeValuePattern.ValueProperty, RangeValuePattern.IsReadOnlyProperty,
            TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
            SelectionItemPattern.IsSelectedProperty
        };

        private static CacheRequest BuildCache()
        {
            CacheRequest cr = new CacheRequest();
            cr.TreeScope = TreeScope.Element;
            cr.TreeFilter = Automation.ControlViewCondition;
            foreach (AutomationProperty p in Props) cr.Add(p);
            return cr;
        }

        /// <summary>Runs work on an MTA thread (UIA's preferred apartment), giving up after timeoutMs.</summary>
        public static bool RunMta(ThreadStart work, int timeoutMs, out Exception error)
        {
            Exception[] caught = new Exception[1];
            Thread t = new Thread(delegate ()
            {
                try { work(); }
                catch (Exception e) { caught[0] = e; }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
            bool done = t.Join(timeoutMs);
            error = caught[0];
            return done;
        }

        private static object Cached(AutomationElement el, AutomationProperty p)
        {
            try
            {
                object v = el.GetCachedPropertyValue(p, true);
                return v == AutomationElement.NotSupported ? null : v;
            }
            catch (Exception) { return null; }
        }

        private static string CStr(AutomationElement el, AutomationProperty p)
        {
            object v = Cached(el, p);
            return v == null ? "" : v.ToString();
        }

        private static bool CBool(AutomationElement el, AutomationProperty p, bool fallback)
        {
            object v = Cached(el, p);
            return v is bool ? (bool)v : fallback;
        }

        public static string RuntimeIdText(int[] id)
        {
            if (id == null) return "";
            string[] parts = new string[id.Length];
            for (int i = 0; i < id.Length; i++) parts[i] = id[i].ToString(CultureInfo.InvariantCulture);
            return string.Join(".", parts);
        }

        private static Rectangle ToRect(object v)
        {
            if (!(v is System.Windows.Rect)) return Rectangle.Empty;
            System.Windows.Rect r = (System.Windows.Rect)v;
            if (r.IsEmpty || double.IsInfinity(r.X) || double.IsNaN(r.X) || r.Width <= 0 || r.Height <= 0)
                return Rectangle.Empty;
            return new Rectangle((int)Math.Round(r.X), (int)Math.Round(r.Y),
                (int)Math.Round(r.Width), (int)Math.Round(r.Height));
        }

        private static UiNode Describe(AutomationElement el, int depth)
        {
            UiNode n = new UiNode();
            n.Depth = depth;
            n.Name = CStr(el, AutomationElement.NameProperty);
            object ct = Cached(el, AutomationElement.ControlTypeProperty);
            if (ct is ControlType)
            {
                string pn = ((ControlType)ct).ProgrammaticName ?? "";
                n.ControlType = pn.StartsWith("ControlType.", StringComparison.Ordinal) ? pn.Substring(12) : pn;
            }
            n.AutomationId = CStr(el, AutomationElement.AutomationIdProperty);
            n.ClassName = CStr(el, AutomationElement.ClassNameProperty);
            n.RuntimeId = RuntimeIdText(Cached(el, AutomationElement.RuntimeIdProperty) as int[]);
            n.Rect = ToRect(Cached(el, AutomationElement.BoundingRectangleProperty));
            n.Enabled = CBool(el, AutomationElement.IsEnabledProperty, true);
            n.Focused = CBool(el, AutomationElement.HasKeyboardFocusProperty, false);
            n.Offscreen = CBool(el, AutomationElement.IsOffscreenProperty, false);
            n.Focusable = CBool(el, AutomationElement.IsKeyboardFocusableProperty, false);

            if (CBool(el, AutomationElement.IsInvokePatternAvailableProperty, false)) n.Actions.Add("invoke");
            if (CBool(el, AutomationElement.IsTogglePatternAvailableProperty, false))
            {
                object ts = Cached(el, TogglePattern.ToggleStateProperty);
                n.Toggle = ts == null ? "?" : ts.ToString();
                n.Actions.Add("toggle");
            }
            if (CBool(el, AutomationElement.IsExpandCollapsePatternAvailableProperty, false))
            {
                object es = Cached(el, ExpandCollapsePattern.ExpandCollapseStateProperty);
                n.Expand = es == null ? null : es.ToString();
                if (n.Expand != "Expanded" && n.Expand != "LeafNode") n.Actions.Add("expand");
                if (n.Expand != "Collapsed" && n.Expand != "LeafNode") n.Actions.Add("collapse");
            }
            if (CBool(el, AutomationElement.IsSelectionItemPatternAvailableProperty, false))
            {
                n.Selected = CBool(el, SelectionItemPattern.IsSelectedProperty, false);
                n.Actions.Add("select");
            }
            if (CBool(el, AutomationElement.IsValuePatternAvailableProperty, false))
            {
                n.Value = CStr(el, ValuePattern.ValueProperty);
                n.ReadOnly = CBool(el, ValuePattern.IsReadOnlyProperty, false);
                if (!n.ReadOnly) n.Actions.Add("set-value");
            }
            else if (CBool(el, AutomationElement.IsRangeValuePatternAvailableProperty, false))
            {
                object rv = Cached(el, RangeValuePattern.ValueProperty);
                n.Value = rv is double ? ((double)rv).ToString("0.###", CultureInfo.InvariantCulture) : CStr(el, RangeValuePattern.ValueProperty);
                n.ReadOnly = CBool(el, RangeValuePattern.IsReadOnlyProperty, false);
                if (!n.ReadOnly) n.Actions.Add("set-value");
            }
            else if (IsNativeEdit(n.ClassName) && n.Enabled)
            {
                n.Actions.Add("set-value");
            }
            // Many toolkits offer ScrollItem on everything; it only matters for what is out of view.
            if (n.Offscreen && CBool(el, AutomationElement.IsScrollItemPatternAvailableProperty, false))
                n.Actions.Add("scrollintoview");
            if (n.Focusable && n.Enabled) n.Actions.Add("focus");
            return n;
        }

        /// <summary>
        /// A pre-order walk of the window's control view, numbering elements from 0, up to
        /// maxElements or timeoutMs. The focused element and selected text are read as well.
        /// </summary>
        public static UiSnapshot Snapshot(IntPtr hwnd, int maxElements, int timeoutMs)
        {
            UiSnapshot snap = new UiSnapshot();
            UiSnapshot live = new UiSnapshot();  // filled by the worker; copied out at the end
            Stopwatch sw = Stopwatch.StartNew();
            uint pid = WindowOps.Pid(hwnd);
            Exception error;
            bool done = RunMta(delegate ()
            {
                CacheRequest cr = BuildCache();
                using (cr.Activate())
                {
                    AutomationElement root = AutomationElement.FromHandle(hwnd);
                    Visit(root, 0, live, maxElements, sw, timeoutMs);
                    ReadFocus(live, (int)pid);
                }
            }, timeoutMs + 4000, out error);
            if (!done)
            {
                snap.Truncated = true;
                snap.Error = "UI Automation stopped answering after " + (sw.ElapsedMilliseconds / 1000)
                    + " s; the tree below is incomplete.";
            }
            else if (error != null)
            {
                snap.Error = "UI Automation failed: " + error.GetType().Name + ": " + error.Message;
            }
            lock (live.Nodes)
            {
                snap.Nodes = new List<UiNode>(live.Nodes);
            }
            if (done)
            {
                snap.FocusedIndex = live.FocusedIndex;
                snap.FocusedLine = live.FocusedLine;
                snap.SelectedText = live.SelectedText;
                snap.Truncated |= live.Truncated;
            }
            return snap;
        }

        private static void Visit(AutomationElement el, int depth, UiSnapshot snap, int max, Stopwatch sw, int budget)
        {
            if (snap.Nodes.Count >= max || sw.ElapsedMilliseconds > budget) { snap.Truncated = true; return; }
            UiNode n = Describe(el, depth);
            lock (snap.Nodes)
            {
                n.Index = snap.Nodes.Count;
                snap.Nodes.Add(n);
            }
            if (depth >= 60) return;
            AutomationElementCollection kids;
            try { kids = el.FindAll(TreeScope.Children, Automation.ControlViewCondition); }
            catch (ElementNotAvailableException) { return; }
            catch (InvalidOperationException) { return; }
            catch (COMException) { return; }
            foreach (AutomationElement k in kids)
            {
                if (snap.Nodes.Count >= max || sw.ElapsedMilliseconds > budget) { snap.Truncated = true; return; }
                Visit(k, depth + 1, snap, max, sw, budget);
            }
        }

        private static void ReadFocus(UiSnapshot snap, int pid)
        {
            AutomationElement f;
            try { f = AutomationElement.FocusedElement; }
            catch (Exception) { return; }
            if (f == null) return;
            try
            {
                if (f.Current.ProcessId != pid) return;
                string id = RuntimeIdText(f.GetRuntimeId());
                foreach (UiNode n in snap.Nodes)
                {
                    if (n.RuntimeId == id && id.Length > 0)
                    {
                        snap.FocusedIndex = n.Index;
                        n.Focused = true;
                        snap.FocusedLine = n.Line();
                        break;
                    }
                }
                if (snap.FocusedLine == null)
                {
                    UiNode d = Describe(f.GetUpdatedCache(BuildCache()), 0);
                    snap.FocusedLine = d.Line() + "  (not in the numbered tree)";
                }
                object tp;
                if (f.TryGetCurrentPattern(TextPattern.Pattern, out tp))
                {
                    System.Windows.Automation.Text.TextPatternRange[] ranges = ((TextPattern)tp).GetSelection();
                    StringBuilder sb = new StringBuilder();
                    foreach (System.Windows.Automation.Text.TextPatternRange r in ranges) sb.Append(r.GetText(4000));
                    if (sb.Length > 0) snap.SelectedText = sb.ToString();
                }
            }
            catch (Exception) { }
        }

        /// <summary>A classic Win32 edit control (multi-line ones expose no Value pattern).</summary>
        public static bool IsNativeEdit(string className)
        {
            return !string.IsNullOrEmpty(className) && className.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>WM_SETTEXT on an edit window, then WM_GETTEXT to see what it now holds.</summary>
        private static string SetEditText(IntPtr edit, string value, out string now)
        {
            now = null;
            IntPtr result;
            if (Native.SendMessageTimeout(edit, 0x000C, IntPtr.Zero, value ?? "", 0x0002, 5000, out result) == IntPtr.Zero)
                return "The edit control did not accept the text (it may be busy or elevated).";
            // A multi-line edit sends no EN_CHANGE for WM_SETTEXT, so the app would not notice;
            // send its parent the notification a typed change would have produced.
            IntPtr parent = Native.GetParent(edit);
            if (parent != IntPtr.Zero)
            {
                int id = Native.GetDlgCtrlID(edit);
                IntPtr wParam = new IntPtr((0x0300 << 16) | (id & 0xFFFF)); // MAKEWPARAM(id, EN_CHANGE)
                Native.SendMessageTimeout(parent, 0x0111, wParam, edit, 0x0002, 5000, out result); // WM_COMMAND
            }
            IntPtr length;
            if (Native.SendMessageTimeout(edit, 0x000E, IntPtr.Zero, (string)null, 0x0002, 5000, out length) != IntPtr.Zero)
            {
                StringBuilder sb = new StringBuilder(Math.Max(1, length.ToInt32() + 1));
                IntPtr copied;
                Native.SendMessageTimeout(edit, 0x000D, new IntPtr(sb.Capacity), sb, 0x0002, 5000, out copied);
                now = sb.ToString();
            }
            return null;
        }

        private static int[] ParseRuntimeId(string text)
        {
            string[] parts = (text ?? "").Split('.');
            List<int> list = new List<int>();
            foreach (string p in parts)
            {
                int v;
                if (int.TryParse(p, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) list.Add(v);
                else return null;
            }
            return list.Count > 0 ? list.ToArray() : null;
        }

        /// <summary>
        /// Performs one UIA action on the element with this runtime id inside the window.
        /// action: invoke, toggle, expand, collapse, select, focus, scrollintoview, set-value.
        /// Returns null on success (result says what happened) or the reason it failed.
        /// </summary>
        public static string Act(IntPtr hwnd, string runtimeId, string action, string value, int timeoutMs, out string result)
        {
            int[] id = ParseRuntimeId(runtimeId);
            result = "";
            if (id == null) return "The observation has no runtime id for that element; run state -Text again.";
            string[] outcome = new string[2];   // [0] failure reason, [1] result
            int[] stage = new int[1];
            string act = (action ?? "invoke").ToLowerInvariant().Replace("-", "").Replace("_", "");
            Exception error;
            bool done = RunMta(delegate ()
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                AutomationElement el = root.FindFirst(TreeScope.Subtree,
                    new PropertyCondition(AutomationElement.RuntimeIdProperty, id));
                if (el == null)
                {
                    outcome[0] = "That element no longer exists; run state -Text again for fresh indexes.";
                    return;
                }
                stage[0] = 1;
                object p;
                switch (act)
                {
                    case "invoke":
                        if (!el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { outcome[0] = Unsupported(el, "Invoke"); return; }
                        ((InvokePattern)p).Invoke();
                        outcome[1] = "invoked";
                        break;
                    case "toggle":
                        if (!el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { outcome[0] = Unsupported(el, "Toggle"); return; }
                        ((TogglePattern)p).Toggle();
                        outcome[1] = "toggled; now " + ((TogglePattern)p).Current.ToggleState;
                        break;
                    case "expand":
                    case "collapse":
                        if (!el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { outcome[0] = Unsupported(el, "ExpandCollapse"); return; }
                        if (act == "expand") ((ExpandCollapsePattern)p).Expand(); else ((ExpandCollapsePattern)p).Collapse();
                        outcome[1] = act == "expand" ? "expanded" : "collapsed";
                        break;
                    case "select":
                        if (!el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { outcome[0] = Unsupported(el, "SelectionItem"); return; }
                        ((SelectionItemPattern)p).Select();
                        outcome[1] = "selected";
                        break;
                    case "focus":
                        el.SetFocus();
                        outcome[1] = "focused";
                        break;
                    case "scrollintoview":
                        if (!el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { outcome[0] = Unsupported(el, "ScrollItem"); return; }
                        ((ScrollItemPattern)p).ScrollIntoView();
                        outcome[1] = "scrolled into view";
                        break;
                    case "setvalue":
                        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p))
                        {
                            ValuePattern vp = (ValuePattern)p;
                            if (vp.Current.IsReadOnly) { outcome[0] = "That element's value is read-only."; return; }
                            vp.SetValue(value ?? "");
                            string now = vp.Current.Value ?? "";
                            outcome[1] = "value set; it now reads " + now.Length + " characters"
                                + (now == (value ?? "") ? " (matches)" : " (differs from what was sent)");
                            break;
                        }
                        if (el.TryGetCurrentPattern(RangeValuePattern.Pattern, out p))
                        {
                            double d;
                            if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                            {
                                outcome[0] = "That element takes a number (RangeValue); '" + value + "' is not one.";
                                return;
                            }
                            ((RangeValuePattern)p).SetValue(d);
                            outcome[1] = "value set to " + ((RangeValuePattern)p).Current.Value.ToString(CultureInfo.InvariantCulture);
                            break;
                        }
                        // Multi-line Win32 edit controls have no Value pattern; their window takes WM_SETTEXT.
                        int native = el.Current.NativeWindowHandle;
                        if (native != 0 && IsNativeEdit(el.Current.ClassName))
                        {
                            string now;
                            string failed = SetEditText(new IntPtr(native), value, out now);
                            if (failed != null) { outcome[0] = failed; return; }
                            outcome[1] = "text set; it now reads " + (now ?? "").Length + " characters"
                                + (now == (value ?? "") ? " (matches)" : " (differs from what was sent)");
                            break;
                        }
                        outcome[0] = Unsupported(el, "Value");
                        return;
                    default:
                        outcome[0] = "Unknown action '" + action + "'.";
                        return;
                }
                stage[0] = 2;
            }, timeoutMs, out error);

            if (!done)
            {
                if (stage[0] == 0) return "UI Automation did not find the element within " + (timeoutMs / 1000) + " s.";
                result = "sent; the app has not answered yet (it may have opened a modal dialog). Observe before continuing.";
                return null;
            }
            if (error != null)
            {
                if (error is ElementNotAvailableException) return "That element no longer exists; run state -Text again.";
                if (error is ElementNotEnabledException) return "That element is disabled.";
                return "UI Automation failed: " + error.GetType().Name + ": " + error.Message;
            }
            if (outcome[0] != null) return outcome[0];
            result = outcome[1] ?? "done";
            return null;
        }

        private static string Unsupported(AutomationElement el, string pattern)
        {
            List<string> have = new List<string>();
            try
            {
                foreach (AutomationPattern ap in el.GetSupportedPatterns())
                {
                    string n = ap.ProgrammaticName ?? "";
                    n = n.Replace("PatternIdentifiers.Pattern", "");
                    have.Add(n);
                }
            }
            catch (Exception) { }
            return "That element does not support the " + pattern + " pattern (it supports: "
                + (have.Count > 0 ? string.Join(", ", have.ToArray()) : "none") + ").";
        }
    }

    /// <summary>
    /// What `state` saw: the window, its screenshot and how image pixels map to the screen, and
    /// optionally the numbered UI Automation tree. Saved as last_observation.json, which
    /// click -Element / -Image, set-value and invoke read back.
    /// </summary>
    public class Observation
    {
        public const int MaxImageEdge = 1568;
        public const double MaxImagePixels = 1150000;

        public string Timestamp = "";
        public WindowInfo Window;
        public string ImagePath;      // null when no screenshot was taken
        public int OriginX, OriginY, SourceWidth, SourceHeight, ImageWidth, ImageHeight;
        public double Zoom = 1.0;
        public string Capture = "";
        public UiSnapshot Ui;         // null unless the tree was asked for
        public List<string> Warnings = new List<string>();

        public static Observation Take(IntPtr hwnd, string imagePath, bool text, double zoom, int maxElements, int timeoutMs)
        {
            Observation o = new Observation();
            o.Timestamp = DateTime.Now.ToString("o", CultureInfo.InvariantCulture);
            o.Window = WindowOps.Info(hwnd);
            if (o.Window == null) throw new InvalidOperationException("The window no longer exists.");
            if (imagePath != null)
            {
                Rectangle frame = o.Window.Bounds;
                string method;
                using (Bitmap shot = ScreenTools.GrabWindow(hwnd, frame, out method))
                {
                    double z = zoom > 0 ? zoom : ScreenTools.AutoZoom(shot.Width, shot.Height, MaxImageEdge, MaxImagePixels);
                    Size saved = ScreenTools.SavePng(shot, imagePath, z);
                    o.ImagePath = imagePath;
                    o.OriginX = frame.Left;
                    o.OriginY = frame.Top;
                    o.SourceWidth = shot.Width;
                    o.SourceHeight = shot.Height;
                    o.ImageWidth = saved.Width;
                    o.ImageHeight = saved.Height;
                    o.Zoom = z;
                    o.Capture = method;
                }
                if (o.Capture == "screen")
                {
                    o.Warnings.Add("The window did not render for PrintWindow, so this is a copy of the screen: "
                        + "anything in front of the window shows in it.");
                    int order = -1;
                    List<WindowInfo> all = ScreenTools.Windows("");
                    foreach (WindowInfo w in all) if (w.Hwnd == o.Window.Hwnd) order = w.Order;
                    foreach (WindowInfo w in all)
                    {
                        if (order >= 0 && w.Order < order && !w.Minimized && w.Bounds.IntersectsWith(frame))
                            o.Warnings.Add("'" + w.Title + "' [" + w.Process + "] is in front of the window and covers part of it.");
                    }
                }
            }
            if (text) o.Ui = Uia.Snapshot(hwnd, maxElements, timeoutMs);
            return o;
        }

        public string ToJson()
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"timestamp\": ").Append(Json.Q(Timestamp));
            sb.Append(", \"window\": ").Append(Window == null ? "null" : Window.ToJson());
            sb.Append(", \"image\": ");
            if (ImagePath == null) sb.Append("null");
            else
            {
                sb.Append("{\"path\": ").Append(Json.Q(ImagePath))
                  .Append(", \"originX\": ").Append(Json.N(OriginX))
                  .Append(", \"originY\": ").Append(Json.N(OriginY))
                  .Append(", \"width\": ").Append(Json.N(ImageWidth))
                  .Append(", \"height\": ").Append(Json.N(ImageHeight))
                  .Append(", \"sourceWidth\": ").Append(Json.N(SourceWidth))
                  .Append(", \"sourceHeight\": ").Append(Json.N(SourceHeight))
                  .Append(", \"zoom\": ").Append(Json.N(Zoom))
                  .Append(", \"capture\": ").Append(Json.Q(Capture)).Append('}');
            }
            sb.Append(", \"hasTree\": ").Append(Json.B(Ui != null));
            if (Ui != null)
            {
                sb.Append(", \"focusedIndex\": ").Append(Ui.FocusedIndex >= 0 ? Json.N(Ui.FocusedIndex) : "null");
                sb.Append(", \"focused\": ").Append(Json.Q(Ui.FocusedLine));
                sb.Append(", \"selectedText\": ").Append(Json.Q(Ui.SelectedText));
                sb.Append(", \"truncated\": ").Append(Json.B(Ui.Truncated));
                sb.Append(", \"treeError\": ").Append(Json.Q(Ui.Error));
                sb.Append(", \"elementCount\": ").Append(Json.N(Ui.Nodes.Count));
            }
            sb.Append(", \"warnings\": [");
            for (int i = 0; i < Warnings.Count; i++) sb.Append(i > 0 ? ", " : "").Append(Json.Q(Warnings[i]));
            sb.Append("], \"elements\": [");
            if (Ui != null)
            {
                for (int i = 0; i < Ui.Nodes.Count; i++)
                {
                    sb.Append(i > 0 ? ",\n  " : "\n  ").Append(Ui.Nodes[i].ToJson());
                }
            }
            sb.Append("]}");
            return sb.ToString();
        }

        public string ToText()
        {
            StringBuilder sb = new StringBuilder();
            WindowInfo w = Window;
            sb.Append("window: hwnd=").Append(w.Hwnd.ToString(CultureInfo.InvariantCulture))
              .Append("  [").Append(w.Process).Append("]  \"").Append(w.Title).Append('"')
              .Append(string.Format(CultureInfo.InvariantCulture, "  x={0} y={1} width={2} height={3}",
                  w.Bounds.X, w.Bounds.Y, w.Bounds.Width, w.Bounds.Height));
            if (w.Minimized) sb.Append("  (minimized)");
            sb.Append('\n');
            if (ImagePath != null)
            {
                sb.Append("image: ").Append(ImagePath).Append('\n');
                sb.Append(string.Format(CultureInfo.InvariantCulture,
                    "  {0}x{1} px, zoom {2}, origin x={3} y={4} (capture: {5})\n",
                    ImageWidth, ImageHeight, Json.N(Zoom), OriginX, OriginY, Capture));
                sb.Append(string.Format(CultureInfo.InvariantCulture,
                    "  image pixel (px,py) is screen pixel ({0} + px/{2}, {1} + py/{2}); or pass -Image to use image pixels directly\n",
                    OriginX, OriginY, Json.N(Zoom)));
            }
            foreach (string warning in Warnings) sb.Append("warning: ").Append(warning).Append('\n');
            if (Ui == null)
            {
                sb.Append("(no accessibility tree; add -Text for numbered elements)\n");
                return sb.ToString();
            }
            if (Ui.Error != null) sb.Append("warning: ").Append(Ui.Error).Append('\n');
            sb.Append("focused: ").Append(Ui.FocusedLine ?? "(nothing in this window has keyboard focus)").Append('\n');
            if (Ui.SelectedText != null)
            {
                string s = Ui.SelectedText.Replace("\r", "\\r").Replace("\n", "\\n");
                if (s.Length > 300) s = s.Substring(0, 300) + "...";
                sb.Append("selected text: \"").Append(s).Append("\"\n");
            }
            sb.Append("elements: ").Append(Ui.Nodes.Count.ToString(CultureInfo.InvariantCulture));
            if (Ui.Truncated) sb.Append(" (truncated; raise -MaxElements or observe a smaller window)");
            sb.Append('\n');
            foreach (UiNode n in Ui.Nodes)
            {
                sb.Append(' ', Math.Min(n.Depth, 30) * 2).Append(n.Line()).Append('\n');
            }
            return sb.ToString();
        }
    }

    /// <summary>A borderless, click-through, always-on-top window painted with per-pixel alpha.</summary>
    public class LayeredOverlay : Form
    {
        private IntPtr _memDc = IntPtr.Zero;
        private IntPtr _hBitmap = IntPtr.Zero;
        private IntPtr _oldBitmap = IntPtr.Zero;
        private Size _size = Size.Empty;
        private Bitmap _canvas;

        public LayeredOverlay()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Native.EX_CLICK_THROUGH;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // The overlay must never show up in the agent's own screenshots.
            Native.HideFromCapture(Handle);
        }

        /// <summary>Caches still artwork as a GDI bitmap so each frame is only a blend, not a redraw.</summary>
        public void SetArtwork(Bitmap bitmap)
        {
            ReleaseArtwork();
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            _memDc = Native.CreateCompatibleDC(screenDc);
            _hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
            _oldBitmap = Native.SelectObject(_memDc, _hBitmap);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
            _size = bitmap.Size;
        }

        /// <summary>A premultiplied surface shared with GDI, for artwork redrawn every frame.</summary>
        public Bitmap UseCanvas(int width, int height)
        {
            ReleaseArtwork();
            Native.BITMAPINFOHEADER header = new Native.BITMAPINFOHEADER();
            header.biSize = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            header.biWidth = width;
            header.biHeight = -height; // top-down, so row 0 is the top as GDI+ expects
            header.biPlanes = 1;
            header.biBitCount = 32;
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr bits;
            _hBitmap = Native.CreateDIBSection(screenDc, ref header, 0, out bits, IntPtr.Zero, 0);
            _memDc = Native.CreateCompatibleDC(screenDc);
            _oldBitmap = Native.SelectObject(_memDc, _hBitmap);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
            _size = new Size(width, height);
            _canvas = new Bitmap(width, height, width * 4, PixelFormat.Format32bppPArgb, bits);
            return _canvas;
        }

        public void Push(int left, int top, byte alpha)
        {
            if (_memDc == IntPtr.Zero) return;
            if (_canvas != null) Native.GdiFlush();
            Native.POINT dst = new Native.POINT(); dst.X = left; dst.Y = top;
            Native.POINT src = new Native.POINT(); src.X = 0; src.Y = 0;
            Native.SIZE size = new Native.SIZE(); size.cx = _size.Width; size.cy = _size.Height;
            Native.BLENDFUNCTION blend = new Native.BLENDFUNCTION();
            blend.BlendOp = 0;            // AC_SRC_OVER
            blend.SourceConstantAlpha = alpha;
            blend.AlphaFormat = 1;        // AC_SRC_ALPHA
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            Native.UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, _memDc, ref src, 0,
                ref blend, Native.ULW_ALPHA);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
        }

        private void ReleaseArtwork()
        {
            if (_canvas != null) { _canvas.Dispose(); _canvas = null; }
            if (_memDc == IntPtr.Zero) return;
            Native.SelectObject(_memDc, _oldBitmap);
            Native.DeleteObject(_hBitmap);
            Native.DeleteDC(_memDc);
            _memDc = IntPtr.Zero; _hBitmap = IntPtr.Zero; _oldBitmap = IntPtr.Zero;
        }

        protected override void Dispose(bool disposing)
        {
            ReleaseArtwork();
            base.Dispose(disposing);
        }
    }

    public static class Artwork
    {
        public enum Edge { Top, Bottom, Left, Right }

        /// <summary>A strip that is solid against the screen edge and fades to nothing inward.</summary>
        public static Bitmap EdgeGlow(int width, int height, Color color, Edge edge, int thickness)
        {
            Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, width, height),
                ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] pixels = new byte[stride * height];
            byte[] falloff = new byte[thickness];
            for (int d = 0; d < thickness; d++)
            {
                double t = 1.0 - ((double)d / thickness);
                falloff[d] = (byte)Math.Round(255.0 * Math.Pow(t, 1.9));
            }
            for (int y = 0; y < height; y++)
            {
                int row = y * stride;
                for (int x = 0; x < width; x++)
                {
                    int d;
                    if (edge == Edge.Top) d = y;
                    else if (edge == Edge.Bottom) d = height - 1 - y;
                    else if (edge == Edge.Left) d = x;
                    else d = width - 1 - x;
                    byte a = d < thickness ? falloff[d] : (byte)0;
                    int i = row + x * 4;
                    pixels[i] = color.B;
                    pixels[i + 1] = color.G;
                    pixels[i + 2] = color.R;
                    pixels[i + 3] = a;
                }
            }
            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            bmp.UnlockBits(data);
            return bmp;
        }
    }

    /// <summary>
    /// The agent's pointer: a grey arrow with a white rim and a soft shadow, over a glow in the
    /// accent colour. The tip sits at the centre of the canvas so it can lean and press in place.
    /// </summary>
    public class CursorSprite : IDisposable
    {
        public readonly int Size;
        private readonly float _s;
        private readonly PointF[] _arrow;
        private Bitmap _fog;
        private Color _fogColor = Color.Empty;

        public CursorSprite(double scale)
        {
            _s = (float)scale;
            Size = (int)Math.Round(140 * scale);
            float u = (float)(1.1 * scale);
            _arrow = new PointF[] {
                new PointF(0, 0),
                new PointF(0, 17.0f * u),
                new PointF(4.4f * u, 13.3f * u),
                new PointF(7.6f * u, 20.4f * u),
                new PointF(10.5f * u, 19.1f * u),
                new PointF(7.4f * u, 12.3f * u),
                new PointF(13.2f * u, 12.3f * u)
            };
        }

        /// <param name="angle">Clockwise lean in degrees, about the tip.</param>
        /// <param name="press">Arrow scale; below 1 while a button is going down.</param>
        /// <param name="fog">Glow strength from 0 to 1.</param>
        /// <param name="pulse">Progress of the click ripple from 0 to 1, or negative for none.</param>
        public void Render(Graphics g, double angle, double press, double fog, double pulse, Color accent)
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float c = Size / 2f;

            EnsureFog(accent);
            using (ImageAttributes attrs = new ImageAttributes())
            {
                ColorMatrix m = new ColorMatrix();
                m.Matrix33 = (float)Math.Max(0, Math.Min(1, fog));
                attrs.SetColorMatrix(m);
                float fx = c + 5 * _s - _fog.Width / 2f, fy = c + 9 * _s - _fog.Height / 2f;
                g.DrawImage(_fog, new Rectangle((int)fx, (int)fy, _fog.Width, _fog.Height),
                    0, 0, _fog.Width, _fog.Height, GraphicsUnit.Pixel, attrs);
            }

            if (pulse >= 0)
            {
                double eased = 1.0 - Math.Pow(1.0 - pulse, 3);
                float r = (float)(4 * _s + 26 * _s * eased);
                int a = (int)Math.Round(220 * (1.0 - pulse));
                using (Pen pen = new Pen(Color.FromArgb(a, accent), (float)(2.6 * _s * (1.0 - 0.5 * pulse))))
                {
                    g.DrawEllipse(pen, c - r, c - r, r * 2, r * 2);
                }
            }

            GraphicsState saved = g.Save();
            g.TranslateTransform(c, c);
            g.RotateTransform((float)angle);
            g.ScaleTransform((float)press, (float)press);
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddPolygon(_arrow);

                GraphicsState beforeShadow = g.Save();
                g.TranslateTransform(1.2f * _s, 2.0f * _s);
                using (Pen blur = new Pen(Color.FromArgb(26, 0, 0, 0), 4.0f * _s))
                {
                    blur.LineJoin = LineJoin.Round;
                    g.DrawPath(blur, path);
                }
                using (SolidBrush shade = new SolidBrush(Color.FromArgb(60, 0, 0, 0)))
                {
                    g.FillPath(shade, path);
                }
                g.Restore(beforeShadow);

                using (SolidBrush body = new SolidBrush(Color.FromArgb(242, 78, 75, 72)))
                {
                    g.FillPath(body, path);
                }
                using (Pen rim = new Pen(Color.FromArgb(240, 255, 255, 255), 1.7f * _s))
                {
                    rim.LineJoin = LineJoin.Round;
                    g.DrawPath(rim, path);
                }
            }
            g.Restore(saved);
        }

        private void EnsureFog(Color color)
        {
            if (_fog != null && _fogColor == color) return;
            if (_fog != null) _fog.Dispose();
            _fogColor = color;
            int size = (int)Math.Round(76 * _s);
            _fog = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            BitmapData data = _fog.LockBits(new Rectangle(0, 0, size, size),
                ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] pixels = new byte[stride * size];
            double r = size / 2.0;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    double dx = x + 0.5 - r, dy = y + 0.5 - r;
                    double t = 1.0 - Math.Sqrt(dx * dx + dy * dy) / r;
                    int i = y * stride + x * 4;
                    pixels[i] = color.B;
                    pixels[i + 1] = color.G;
                    pixels[i + 2] = color.R;
                    pixels[i + 3] = t <= 0 ? (byte)0 : (byte)Math.Round(125.0 * Math.Pow(t, 1.5));
                }
            }
            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            _fog.UnlockBits(data);
        }

        public void Dispose()
        {
            if (_fog != null) _fog.Dispose();
        }
    }

    /// <summary>
    /// One journey of the agent's pointer: a gently bowed cubic curve travelled with the
    /// minimum-jerk speed profile of a human reach, taking longer for longer distances.
    /// </summary>
    public class Glide
    {
        public readonly double StartMs;
        public readonly double DurationMs;
        private readonly double _x0, _y0, _x1, _y1, _x2, _y2, _x3, _y3;

        public Glide(double x0, double y0, double x3, double y3, double scale, double startMs, Random rng)
        {
            StartMs = startMs;
            _x0 = x0; _y0 = y0; _x3 = x3; _y3 = y3;
            double dx = x3 - x0, dy = y3 - y0;
            double d = Math.Sqrt(dx * dx + dy * dy);
            if (d < 1)
            {
                DurationMs = 0;
                _x1 = _x2 = x3; _y1 = _y2 = y3;
                return;
            }
            double logical = d / scale;
            DurationMs = Math.Max(180, Math.Min(950, 200 + 115 * Math.Log(1 + logical / 35.0, 2)));
            double nx = -dy / d, ny = dx / d;
            double side = dx >= 0 ? -1 : 1;
            double arc = Math.Min(0.14 * d, 110 * scale) * side * (0.7 + 0.6 * rng.NextDouble());
            _x1 = x0 + dx * 0.28 + nx * arc; _y1 = y0 + dy * 0.28 + ny * arc;
            _x2 = x0 + dx * 0.78 + nx * arc * 0.55; _y2 = y0 + dy * 0.78 + ny * arc * 0.55;
        }

        /// <summary>Position at time now; returns true once the journey is over.</summary>
        public bool At(double now, out double x, out double y)
        {
            double t = DurationMs <= 0 ? 1 : Math.Max(0, Math.Min(1, (now - StartMs) / DurationMs));
            double s = t * t * t * (10 - 15 * t + 6 * t * t);
            double u = 1 - s;
            x = u * u * u * _x0 + 3 * u * u * s * _x1 + 3 * u * s * s * _x2 + s * s * s * _x3;
            y = u * u * u * _y0 + 3 * u * u * s * _y1 + 3 * u * s * s * _y2 + s * s * s * _y3;
            return t >= 1;
        }
    }

    /// <summary>State the agent publishes, read back from state.json.</summary>
    public class ControlState
    {
        public bool Active;
        public string Session = "";
        public string Agent = "";
        public string Action = "";
        public DateTime Started = DateTime.MinValue;
        public DateTime Heartbeat = DateTime.MinValue;
        public bool ReleaseRequested;
        public string Color = "";
        public int Thickness;
        public bool ShowCursor = true;
        public bool ShowEdges = true;
        public string PanelPosition = "TopCenter";
        public int IdleExitMinutes;

        public int CursorSeq;
        public string CursorAction = "";
        public int CursorX, CursorY, CursorToX, CursorToY;
        public string CursorButton = "left";
        public int CursorCount = 1;
        public int CursorScrollX, CursorScrollY;
        public string CursorWindow = "";
        public DateTime CursorIssued = DateTime.MinValue;

        private static int I(string json, string key, int fallback)
        {
            long? v = Json.Int(json, key);
            return v.HasValue ? (int)v.Value : fallback;
        }

        private static DateTime Time(string json, string key)
        {
            string raw = Json.Str(json, key);
            DateTime parsed;
            if (!string.IsNullOrEmpty(raw) && DateTime.TryParse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out parsed)) return parsed.ToLocalTime();
            return DateTime.MinValue;
        }

        public static ControlState Read(string path)
        {
            string json = FileUtil.ReadShared(path);
            if (json == null || json.IndexOf('}') < 0) return null;

            ControlState s = new ControlState();
            bool? active = Json.Bool(json, "active");
            s.Active = active.HasValue && active.Value;
            s.Session = Json.Str(json, "session") ?? "";
            s.Agent = Json.Str(json, "agent") ?? "Agent";
            if (s.Agent.Length == 0) s.Agent = "Agent";
            s.Action = Json.Str(json, "action") ?? "";
            s.Started = Time(json, "started");
            s.Heartbeat = Time(json, "heartbeat");
            bool? release = Json.Bool(json, "release_requested");
            s.ReleaseRequested = release.HasValue && release.Value;
            s.Color = Json.Str(json, "color") ?? "#FF9A1F";
            s.Thickness = I(json, "thickness", 0);
            bool? cursor = Json.Bool(json, "show_cursor");
            s.ShowCursor = !cursor.HasValue || cursor.Value;
            bool? edges = Json.Bool(json, "show_edges");
            s.ShowEdges = !edges.HasValue || edges.Value;
            s.PanelPosition = Json.Str(json, "panel_position") ?? "TopCenter";
            s.IdleExitMinutes = I(json, "idle_exit_minutes", 0);

            s.CursorSeq = I(json, "cursor_seq", 0);
            s.CursorAction = Json.Str(json, "cursor_action") ?? "";
            s.CursorX = I(json, "cursor_x", 0);
            s.CursorY = I(json, "cursor_y", 0);
            s.CursorToX = I(json, "cursor_to_x", 0);
            s.CursorToY = I(json, "cursor_to_y", 0);
            s.CursorButton = Json.Str(json, "cursor_button") ?? "left";
            s.CursorCount = Math.Max(1, Math.Min(5, I(json, "cursor_count", 1)));
            s.CursorScrollX = Math.Max(-50, Math.Min(50, I(json, "cursor_scroll_x", 0)));
            s.CursorScrollY = Math.Max(-50, Math.Min(50, I(json, "cursor_scroll_y", 0)));
            s.CursorWindow = Json.Str(json, "cursor_window") ?? "";
            s.CursorIssued = Time(json, "cursor_issued");
            return s;
        }

        /// <summary>
        /// Sets release_requested (and when and why) in state.json, as the panel's Release button,
        /// a physical Escape, or the `release` command do. Returns false if it could not be written.
        /// </summary>
        public static bool RequestRelease(string path, string source)
        {
            string json = FileUtil.ReadShared(path);
            if (json == null || json.IndexOf('}') < 0) json = "{\"active\": false}";
            if (Regex.IsMatch(json, "\"release_requested\"\\s*:\\s*true")) return true;
            json = SetField(json, "release_requested", "true");
            json = SetField(json, "released_at", Json.Q(DateTime.Now.ToString("o", CultureInfo.InvariantCulture)));
            json = SetField(json, "release_source", Json.Q(source));
            try { return FileUtil.WriteAtomic(path, json); }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        /// <summary>Replaces a top-level scalar field's value, or adds the field before the closing brace.</summary>
        public static string SetField(string json, string key, string rawValue)
        {
            Regex field = new Regex("(\"" + Regex.Escape(key) + "\"\\s*:\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"|true|false|null|-?[0-9.eE+-]+)");
            if (field.IsMatch(json)) return field.Replace(json, "${1}" + rawValue.Replace("$", "$$"), 1);
            int end = json.LastIndexOf('}');
            if (end < 0) return json;
            string head = json.Substring(0, end).TrimEnd();
            string sep = head.EndsWith("{", StringComparison.Ordinal) ? "" : ",";
            return head + sep + "\n    \"" + key + "\": " + rawValue + "\n" + json.Substring(end);
        }
    }

    public class StatusPanel : Form
    {
        private readonly Button _release;
        private readonly double _scale;
        private string _agent = "Agent";
        private string _action = "";
        private string _elapsed = "";
        private Color _accent = Color.FromArgb(255, 154, 31);
        private bool _waiting;
        private bool _released;

        public bool ReleaseClicked { get; private set; }

        public StatusPanel(double scale, Rectangle screen, string position)
        {
            _scale = scale;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            BackColor = Color.FromArgb(18, 18, 20);
            DoubleBuffered = true;

            int w = S(600), h = S(80);
            Size = new Size(w, h);
            Location = Place(screen, w, h, position);

            _release = new Button();
            _release.Text = "Release";
            _release.FlatStyle = FlatStyle.Flat;
            _release.FlatAppearance.BorderSize = 1;
            _release.FlatAppearance.BorderColor = Color.FromArgb(92, 92, 98);
            _release.BackColor = Color.FromArgb(34, 34, 38);
            _release.ForeColor = Color.FromArgb(226, 226, 230);
            _release.Font = new Font("Segoe UI", (float)(8.5 * _scale), FontStyle.Regular);
            _release.Size = new Size(S(86), S(30));
            _release.Location = new Point(w - S(86) - S(14), (h - S(30)) / 2);
            _release.TabStop = false;
            _release.Click += delegate { ReleaseClicked = true; };
            Controls.Add(_release);
        }

        private int S(int v) { return (int)Math.Round(v * _scale); }

        private Point Place(Rectangle screen, int w, int h, string position)
        {
            int inset = S(52);
            int left = position.EndsWith("Right", StringComparison.OrdinalIgnoreCase)
                ? screen.Right - w - inset
                : screen.Left + (screen.Width - w) / 2;
            int top = position.StartsWith("Bottom", StringComparison.OrdinalIgnoreCase)
                ? screen.Bottom - h - S(72)
                : screen.Top + inset;
            return new Point(left, top);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Native.EX_PANEL;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.HideFromCapture(Handle);
        }

        public void Update(string agent, string action, string elapsed, Color accent, bool waiting, bool released)
        {
            bool changed = _agent != agent || _action != action || _elapsed != elapsed
                || _accent != accent || _waiting != waiting || _released != released;
            _agent = agent; _action = action; _elapsed = elapsed;
            _accent = accent; _waiting = waiting; _released = released;
            if (changed) Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            g.Clear(Color.FromArgb(18, 18, 20));

            using (Pen border = new Pen(_accent, S(2)))
            {
                g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            }

            int dot = S(10);
            int dotX = S(16), dotY = (Height - dot) / 2;
            using (SolidBrush brush = new SolidBrush(_waiting ? Color.FromArgb(120, _accent) : _accent))
            {
                g.FillEllipse(brush, dotX, dotY, dot, dot);
            }

            int textLeft = dotX + dot + S(12);
            int textRight = _release.Left - S(12);
            using (Font head = new Font("Segoe UI", (float)(8.0 * _scale), FontStyle.Regular))
            using (Font body = new Font("Segoe UI", (float)(10.0 * _scale), FontStyle.Regular))
            using (Font hint = new Font("Segoe UI", (float)(7.5 * _scale), FontStyle.Regular))
            using (SolidBrush dim = new SolidBrush(Color.FromArgb(150, 150, 158)))
            using (SolidBrush bright = new SolidBrush(Color.FromArgb(238, 238, 242)))
            {
                StringFormat fmt = new StringFormat();
                fmt.Trimming = StringTrimming.EllipsisCharacter;
                fmt.FormatFlags = StringFormatFlags.NoWrap;

                string header = _agent.ToUpperInvariant() + (_released ? "  -  RELEASE REQUESTED" : "  -  IN CONTROL");
                if (_elapsed.Length > 0 && !_released) header += "  -  " + _elapsed;
                if (_waiting && !_released) header += "  -  WAITING";
                g.DrawString(header, head, dim, new RectangleF(textLeft, S(8), textRight - textLeft, S(18)), fmt);

                string line = _released ? "Control is back with you; the agent has been told to stop."
                    : (_action.Length > 0 ? _action : "-");
                g.DrawString(line, body, bright, new RectangleF(textLeft, S(26), textRight - textLeft, S(26)), fmt);

                if (!_released)
                    g.DrawString("Esc or Release to take back control", hint, dim,
                        new RectangleF(textLeft, S(53), textRight - textLeft, S(18)), fmt);
            }
        }
    }

    public class Overlay
    {
        private enum StepKind { Check, Glide, Wait, Save, Jump, Down, Up, Wheel, Restore, Press, Pulse, Ack }

        private class Step
        {
            public StepKind Kind;
            public int X, Y, Ms, Button, Delta;
            public bool RealFollows, Horizontal;
            public Step(StepKind kind) { Kind = kind; }
        }

        private readonly string _statePath;
        private readonly string _stateDir;
        private readonly string _ackPath;
        private readonly Rectangle _screen;
        private readonly double _scale;
        private readonly int _idleExitMinutes;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly Random _rng = new Random();

        private LayeredOverlay[] _edges;
        private LayeredOverlay _cursorWindow;
        private CursorSprite _sprite;
        private Graphics _cursorGraphics;
        private StatusPanel _panel;
        private ControlState _state;
        private Color _accent = Color.Empty;
        private int _thickness;
        private int _tick;
        private byte _lastEdgeAlpha = 0;
        private DateTime _lastGoodRead = DateTime.Now;
        private bool _waiting;

        // Release: the panel button, a physical Escape, or the `release` command.
        private Native.LowLevelKeyboardProc _hookProc;
        private IntPtr _hook = IntPtr.Zero;
        private volatile bool _escPressed;
        private bool _releaseLatched;
        private string _latchedSession = "";
        private double _releaseSeenAt = -1;

        // The agent's pointer.
        private double _vx, _vy, _prevX, _prevT, _tilt, _restSince, _shownAt;
        private double _pressStart = -1, _pulseStart = -1;
        private Glide _glide;
        private bool _realFollows;

        // The command being carried out.
        private int _lastSeq;
        private int _commandSeq;
        private List<Step> _steps;
        private int _stepIndex;
        private bool _stepStarted;
        private double _stepStart;
        private string _targetInfo = "";
        private long _targetHwnd;
        private string _targetProcess = "";
        private int _wheelSent;
        private double _commandStart;
        private double _lastFrame;
        private readonly StringBuilder _trace = new StringBuilder();
        private Native.POINT _savedReal;
        private bool _hasSavedReal;
        private bool _buttonDown;
        private int _buttonHeld;

        public Overlay(string statePath, int idleExitMinutes)
        {
            _statePath = statePath;
            _stateDir = Path.GetDirectoryName(statePath);
            _ackPath = Path.Combine(_stateDir, "cursor_ack.json");
            _idleExitMinutes = idleExitMinutes;
            _screen = Screen.PrimaryScreen.Bounds;
            double s = _screen.Height / 1080.0;
            _scale = Math.Max(1.0, Math.Min(2.0, s));
            Policy.Configure(_stateDir);
        }

        public static void Run(string statePath, int idleExitMinutes)
        {
            Native.UseRealPixels();
            Application.EnableVisualStyles();
            Overlay o = new Overlay(statePath, idleExitMinutes);
            try
            {
                o.Start();
            }
            finally
            {
                o.Cleanup();
            }
        }

        private string Pid { get { return Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture); } }

        private void Start()
        {
            _state = ControlState.Read(_statePath);
            if (_state == null || !_state.Active) return;

            _thickness = _state.Thickness > 0 ? _state.Thickness : (int)Math.Round(28 * _scale);
            _lastSeq = ReadAckSeq();

            _edges = new LayeredOverlay[4];
            for (int i = 0; i < 4; i++) { _edges[i] = new LayeredOverlay(); _edges[i].Show(); }

            // Sized to sit close to the system arrow rather than to the rest of the overlay.
            _sprite = new CursorSprite(_scale * 0.72);
            _cursorWindow = new LayeredOverlay();
            _cursorGraphics = Graphics.FromImage(_cursorWindow.UseCanvas(_sprite.Size, _sprite.Size));
            _cursorWindow.Show();
            Native.POINT start = RealPointer.Where();
            _vx = _prevX = start.X; _vy = start.Y;
            _shownAt = _restSince = _prevT = _clock.Elapsed.TotalMilliseconds;

            _panel = new StatusPanel(_scale, _screen, _state.PanelPosition);
            _panel.Show();

            ApplyAccent(Accent(_state));
            InstallEscapeHook();

            try
            {
                File.WriteAllText(Path.Combine(_stateDir, "overlay.pid"), Pid, Encoding.ASCII);
                File.WriteAllText(Path.Combine(_stateDir, "overlay.ready"), Pid, Encoding.ASCII);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }

            Timer timer = new Timer();
            timer.Interval = 15;
            timer.Tick += delegate { Frame(timer); };
            timer.Start();
            Application.Run();
        }

        /// <summary>
        /// A physical Escape press means the person wants the screen back. Injected keys (the
        /// agent's own key presses) are ignored, and the key is always passed on, never swallowed.
        /// </summary>
        private void InstallEscapeHook()
        {
            _hookProc = HookProc;
            _hook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _hookProc, Native.GetModuleHandle(null), 0);
            Log(_hook == IntPtr.Zero
                ? "escape hook failed (error " + Marshal.GetLastWin32Error() + "); only the Release button releases"
                : "escape hook installed");
        }

        private IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0)
                {
                    int msg = wParam.ToInt32();
                    if (msg == 0x0100 || msg == 0x0104) // WM_KEYDOWN, WM_SYSKEYDOWN
                    {
                        Native.KBDLLHOOKSTRUCT k = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                        if (k.vkCode == 0x1B && (k.flags & Native.LLKHF_INJECTED) == 0) _escPressed = true;
                    }
                }
            }
            catch (Exception) { }
            return Native.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private void Cleanup()
        {
            if (_hook != IntPtr.Zero)
            {
                Native.UnhookWindowsHookEx(_hook);
                _hook = IntPtr.Zero;
            }
            ReleaseInput();
            foreach (string name in new string[] { "overlay.pid", "overlay.ready" })
            {
                string path = Path.Combine(_stateDir, name);
                try
                {
                    string content = FileUtil.ReadShared(path);
                    if (content != null && content.Trim() == Pid) File.Delete(path);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        private void Log(string line)
        {
            try
            {
                File.AppendAllText(Path.Combine(_stateDir, "overlay.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
                    + " " + line + Environment.NewLine, Encoding.UTF8);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private static Color Accent(ControlState state)
        {
            if (state.ReleaseRequested) return Color.FromArgb(232, 62, 62);
            try
            {
                return ColorTranslator.FromHtml(state.Color);
            }
            catch (Exception) { return Color.FromArgb(255, 154, 31); }
        }

        private void ApplyAccent(Color color)
        {
            if (_accent == color) return;
            _accent = color;
            SetEdge(0, _screen.Width, _thickness, Artwork.Edge.Top);
            SetEdge(1, _screen.Width, _thickness, Artwork.Edge.Bottom);
            SetEdge(2, _thickness, _screen.Height, Artwork.Edge.Left);
            SetEdge(3, _thickness, _screen.Height, Artwork.Edge.Right);
            _lastEdgeAlpha = 0;
        }

        private void SetEdge(int index, int width, int height, Artwork.Edge edge)
        {
            using (Bitmap bmp = Artwork.EdgeGlow(width, height, _accent, edge, _thickness))
            {
                _edges[index].SetArtwork(bmp);
            }
        }

        private void Frame(Timer timer)
        {
            _tick++;
            double now = _clock.Elapsed.TotalMilliseconds;
            if (_steps != null && now - _lastFrame > 400)
                _trace.Append(" [frame gap ").Append((int)(now - _lastFrame)).Append("ms]");
            _lastFrame = now;

            // A release from the panel or a physical Escape is written straight away.
            if (!_releaseLatched && (_panel.ReleaseClicked || _escPressed))
            {
                string source = _escPressed ? "escape" : "panel";
                ControlState.RequestRelease(_statePath, source);
                Log("release requested (" + source + ")");
                _releaseLatched = true;
                _latchedSession = _state.Session;
                _state.ReleaseRequested = true;
            }

            // The file is read about twenty times a second; the pointer animates every tick.
            if (_tick % 3 == 1)
            {
                ControlState fresh = ControlState.Read(_statePath);
                if (fresh == null)
                {
                    // A momentary read failure is a write in progress; a persistent one means gone.
                    if ((DateTime.Now - _lastGoodRead).TotalSeconds > 5) { Quit(timer); return; }
                }
                else
                {
                    _lastGoodRead = DateTime.Now;
                    if (fresh.ReleaseRequested && !_releaseLatched)
                    {
                        _releaseLatched = true;
                        _latchedSession = fresh.Session;
                    }
                    else if (_releaseLatched && !fresh.ReleaseRequested && fresh.Session == _latchedSession && fresh.Active)
                    {
                        // Someone rewrote the file from a stale copy; the release still stands.
                        ControlState.RequestRelease(_statePath, "reasserted");
                        fresh.ReleaseRequested = true;
                    }
                    else if (_releaseLatched && fresh.Session != _latchedSession)
                    {
                        _releaseLatched = false;   // a fresh `start` began a new session
                        _releaseSeenAt = -1;
                    }
                    _state = fresh;
                    if (!_state.Active) { Quit(timer); return; }

                    int idleMinutes = _state.IdleExitMinutes > 0 ? _state.IdleExitMinutes : _idleExitMinutes;
                    double idleSeconds = _state.Heartbeat == DateTime.MinValue
                        ? 0 : (DateTime.Now - _state.Heartbeat).TotalSeconds;
                    if (idleSeconds > idleMinutes * 60.0) { Log("idle exit"); Quit(timer); return; }
                    _waiting = idleSeconds > 25 && _steps == null;

                    ApplyAccent(Accent(_state));
                    _panel.Update(_state.Agent, _state.Action, Elapsed(_state.Started), _accent, _waiting,
                        _state.ReleaseRequested);
                    TakeCommand(now);
                }
            }

            // After a release the overlay shows red briefly, then gets out of the way.
            if (_state.ReleaseRequested)
            {
                if (_releaseSeenAt < 0) _releaseSeenAt = now;
                else if (now - _releaseSeenAt > 2500 && _steps == null) { Log("exit after release"); Quit(timer); return; }
            }

            RunSteps(now);

            // Masked because TickCount goes negative after 24.9 days of uptime.
            double phase = ((Environment.TickCount & int.MaxValue) % 2400) / 2400.0;
            double wave = 0.5 - 0.5 * Math.Cos(phase * 2 * Math.PI);

            if (_state.ShowEdges)
            {
                byte edgeAlpha = (byte)Math.Round(95 + 85 * wave);
                if (edgeAlpha != _lastEdgeAlpha && _tick % 4 == 0)
                {
                    _lastEdgeAlpha = edgeAlpha;
                    _edges[0].Push(_screen.Left, _screen.Top, edgeAlpha);
                    _edges[1].Push(_screen.Left, _screen.Bottom - _thickness, edgeAlpha);
                    _edges[2].Push(_screen.Left, _screen.Top, edgeAlpha);
                    _edges[3].Push(_screen.Right - _thickness, _screen.Top, edgeAlpha);
                }
            }

            AnimateCursor(now, wave);

            if (_tick % 60 == 0) KeepOnTop();
        }

        private void AnimateCursor(double now, double wave)
        {
            if (_glide != null)
            {
                bool done = _glide.At(now, out _vx, out _vy);
                if (_realFollows)
                {
                    if (_state.ReleaseRequested)
                    {
                        Abort(true, "Release was requested during the drag; the button was let go.");
                    }
                    else RealPointer.MoveTo((int)Math.Round(_vx), (int)Math.Round(_vy), true);
                }
                if (done) { _glide = null; _realFollows = false; _restSince = now; }
            }

            // Lean with sideways speed, as a hand-held pointer would, then settle upright.
            double dt = Math.Max(1, now - _prevT);
            double speed = (_vx - _prevX) / dt * 1000.0 / _scale;
            _prevX = _vx; _prevT = now;
            double lean = Math.Max(-18, Math.Min(18, speed * 0.012));
            _tilt += (lean - _tilt) * (1 - Math.Exp(-dt / 90.0));

            // At rest, a small sway about the tip shows the agent is still at work.
            double rest = _glide == null ? Math.Max(0, Math.Min(1, (now - _restSince - 250) / 400.0)) : 0;
            double sway = (_waiting ? 4 : 9) * rest * Math.Sin(now / 1400.0 * 2 * Math.PI);

            double press = 1.0;
            if (_pressStart >= 0)
            {
                double p = (now - _pressStart) / 180.0;
                if (p >= 1) _pressStart = -1;
                else press = 1.0 - 0.14 * Math.Sin(p * Math.PI);
            }
            double pulse = -1;
            if (_pulseStart >= 0)
            {
                double p = (now - _pulseStart) / 420.0;
                if (p >= 1) _pulseStart = -1;
                else pulse = p;
            }

            if (!_state.ShowCursor)
            {
                _cursorWindow.Push(0, 0, 0);
                return;
            }
            double fog = _glide != null ? 1.0 : 0.55 + 0.45 * wave;
            _sprite.Render(_cursorGraphics, _tilt + sway, press, fog, pulse, _accent);
            byte alpha = (byte)Math.Round(255 * Math.Min(1.0, (now - _shownAt) / 300.0));
            int half = _sprite.Size / 2;
            _cursorWindow.Push((int)Math.Round(_vx) - half, (int)Math.Round(_vy) - half, alpha);
        }

        private void TakeCommand(double now)
        {
            // A fresh 'start' resets the sequence; everything after it is new.
            if (_state.CursorSeq < _lastSeq) _lastSeq = 0;
            if (_steps != null || _state.CursorSeq <= _lastSeq) return;
            _lastSeq = _state.CursorSeq;
            _commandSeq = _state.CursorSeq;
            _targetInfo = "";
            _targetHwnd = 0;
            _targetProcess = "";
            _wheelSent = 0;
            _commandStart = now;
            _trace.Length = 0;

            if (_state.ReleaseRequested)
            {
                WriteAck(false, true, "Release was requested, so nothing was done.");
                return;
            }
            if (_state.CursorIssued != DateTime.MinValue
                && (DateTime.Now - _state.CursorIssued).TotalSeconds > 20)
            {
                WriteAck(false, false, "The pointer command was too old to run safely, so it was skipped.");
                return;
            }
            if (!RealPointer.InputSizeIsRight)
            {
                WriteAck(false, false, "Windows input cannot be sent from this process (INPUT is "
                    + Marshal.SizeOf(typeof(Native.INPUT)) + " bytes).");
                return;
            }
            _steps = Plan(_state);
            if (_steps == null)
            {
                WriteAck(false, false, "Unknown pointer command '" + _state.CursorAction + "'.");
                return;
            }
            _stepIndex = 0;
            _stepStarted = false;
        }

        private List<Step> Plan(ControlState s)
        {
            string kind = (s.CursorAction ?? "").ToLowerInvariant();
            int x = s.CursorX, y = s.CursorY;
            string b = (s.CursorButton ?? "left").ToLowerInvariant();
            int button = b == "right" ? 1 : (b == "middle" ? 2 : 0);
            int count = s.CursorCount;
            // Older names for the same thing.
            if (kind == "right") { kind = "click"; button = 1; }
            if (kind == "double") { kind = "click"; button = 0; count = 2; }

            List<Step> p = new List<Step>();
            if (kind == "move")
            {
                p.Add(GlideTo(x, y, false));
            }
            else if (kind == "point")
            {
                // Looks like a click, touches nothing: for demonstrations.
                p.Add(GlideTo(x, y, false));
                p.Add(Wait(70));
                p.Add(new Step(StepKind.Press));
                p.Add(new Step(StepKind.Pulse));
                p.Add(Wait(320));
            }
            else if (kind == "click")
            {
                p.Add(At(StepKind.Check, x, y));
                p.Add(GlideTo(x, y, false));
                p.Add(Wait(70));
                p.Add(At(StepKind.Check, x, y));
                p.Add(new Step(StepKind.Save));
                p.Add(At(StepKind.Jump, x, y));
                p.Add(Wait(25));
                p.Add(new Step(StepKind.Press));
                for (int i = 0; i < count; i++)
                {
                    if (i > 0) p.Add(Wait(55));
                    p.Add(ButtonStep(StepKind.Down, button));
                    p.Add(Wait(i == 0 ? 45 : 30));
                    p.Add(ButtonStep(StepKind.Up, button));
                }
                p.Add(Wait(40));
                p.Add(new Step(StepKind.Restore));
                p.Add(new Step(StepKind.Pulse));
                p.Add(Wait(160));
            }
            else if (kind == "scroll")
            {
                p.Add(At(StepKind.Check, x, y));
                p.Add(GlideTo(x, y, false));
                p.Add(Wait(60));
                p.Add(At(StepKind.Check, x, y));
                p.Add(new Step(StepKind.Save));
                p.Add(At(StepKind.Jump, x, y));
                p.Add(Wait(30));
                p.Add(new Step(StepKind.Press));
                // Positive means down / right; the wheel counts up / right as positive.
                for (int i = 0; i < Math.Abs(s.CursorScrollY); i++)
                {
                    p.Add(WheelStep(s.CursorScrollY > 0 ? -120 : 120, false));
                    p.Add(Wait(40));
                }
                for (int i = 0; i < Math.Abs(s.CursorScrollX); i++)
                {
                    p.Add(WheelStep(s.CursorScrollX > 0 ? 120 : -120, true));
                    p.Add(Wait(40));
                }
                p.Add(Wait(80));
                p.Add(new Step(StepKind.Restore));
                p.Add(new Step(StepKind.Pulse));
                p.Add(Wait(120));
            }
            else if (kind == "drag")
            {
                p.Add(At(StepKind.Check, x, y));
                p.Add(At(StepKind.Check, s.CursorToX, s.CursorToY));
                p.Add(GlideTo(x, y, false));
                p.Add(Wait(70));
                p.Add(At(StepKind.Check, x, y));
                p.Add(new Step(StepKind.Save));
                p.Add(At(StepKind.Jump, x, y));
                p.Add(Wait(40));
                p.Add(new Step(StepKind.Press));
                p.Add(ButtonStep(StepKind.Down, 0));
                p.Add(Wait(80));
                p.Add(GlideTo(s.CursorToX, s.CursorToY, true));
                p.Add(Wait(90));
                p.Add(ButtonStep(StepKind.Up, 0));
                p.Add(Wait(40));
                p.Add(new Step(StepKind.Restore));
                p.Add(new Step(StepKind.Pulse));
                p.Add(Wait(160));
            }
            else return null;
            p.Add(new Step(StepKind.Ack));
            return p;
        }

        private static Step At(StepKind kind, int x, int y)
        {
            Step s = new Step(kind); s.X = x; s.Y = y; return s;
        }

        private static Step GlideTo(int x, int y, bool realFollows)
        {
            Step s = At(StepKind.Glide, x, y); s.RealFollows = realFollows; return s;
        }

        private static Step Wait(int ms)
        {
            Step s = new Step(StepKind.Wait); s.Ms = ms; return s;
        }

        private static Step ButtonStep(StepKind kind, int button)
        {
            Step s = new Step(kind); s.Button = button; return s;
        }

        private static Step WheelStep(int delta, bool horizontal)
        {
            Step s = new Step(StepKind.Wheel); s.Delta = delta; s.Horizontal = horizontal; return s;
        }

        private void RunSteps(double now)
        {
            while (_steps != null && _stepIndex < _steps.Count)
            {
                Step s = _steps[_stepIndex];
                if (!_stepStarted)
                {
                    _stepStarted = true;
                    _stepStart = now;
                    _trace.Append(' ').Append(s.Kind).Append('@')
                        .Append(((int)(now - _commandStart)).ToString(CultureInfo.InvariantCulture));
                    double began = _clock.Elapsed.TotalMilliseconds;
                    if (!StartStep(s, now)) return;
                    double took = _clock.Elapsed.TotalMilliseconds - began;
                    if (took > 50) _trace.Append("(took ").Append((int)took).Append(')');
                }
                if (_steps == null) return;
                if (s.Kind == StepKind.Glide && _glide != null) return;
                if (s.Kind == StepKind.Wait && now - _stepStart < s.Ms) return;
                _stepIndex++;
                _stepStarted = false;
            }
            _steps = null;
        }

        /// <summary>Begins a step; returns false when it aborted the command.</summary>
        private bool StartStep(Step s, double now)
        {
            switch (s.Kind)
            {
                case StepKind.Check:
                    return CheckTarget(s.X, s.Y);
                case StepKind.Glide:
                    _glide = new Glide(_vx, _vy, s.X, s.Y, _scale, now, _rng);
                    _realFollows = s.RealFollows;
                    return true;
                case StepKind.Save:
                    _savedReal = RealPointer.Where();
                    _hasSavedReal = true;
                    return true;
                case StepKind.Jump:
                    if (_state.ReleaseRequested)
                    {
                        Abort(true, "Release was requested, so nothing was clicked.");
                        return false;
                    }
                    if (!RealPointer.MoveTo(s.X, s.Y, false))
                    {
                        Abort(false, "The real pointer could not be moved to the target.");
                        return false;
                    }
                    return true;
                case StepKind.Down:
                    if (_state.ReleaseRequested)
                    {
                        Abort(true, "Release was requested, so the click was not finished.");
                        return false;
                    }
                    if (!RealPointer.Button(s.Button, true))
                    {
                        Abort(false, "Windows refused the button press (error "
                            + Marshal.GetLastWin32Error() + ").");
                        return false;
                    }
                    _buttonDown = true;
                    _buttonHeld = s.Button;
                    return true;
                case StepKind.Up:
                    RealPointer.Button(s.Button, false);
                    _buttonDown = false;
                    return true;
                case StepKind.Wheel:
                    if (_state.ReleaseRequested)
                    {
                        Abort(true, "Release was requested during the scroll; " + _wheelSent + " notch(es) had been sent.");
                        return false;
                    }
                    if (!RealPointer.Wheel(s.Delta, s.Horizontal))
                    {
                        Abort(false, "Windows refused the wheel input (error " + Marshal.GetLastWin32Error() + ").");
                        return false;
                    }
                    _wheelSent++;
                    return true;
                case StepKind.Restore:
                    RestoreReal();
                    return true;
                case StepKind.Press:
                    _pressStart = now;
                    return true;
                case StepKind.Pulse:
                    _pulseStart = now;
                    return true;
                case StepKind.Ack:
                    WriteAck(true, false, "");
                    return true;
            }
            return true;
        }

        private bool CheckTarget(int x, int y)
        {
            if (_panel.Bounds.Contains(x, y))
            {
                Abort(false, "The target is under the status panel. Move the panel with start -Position.");
                return false;
            }
            IntPtr root = WindowOps.RootAt(x, y);
            string title = root == IntPtr.Zero ? "" : WindowOps.Title(root);
            string process = root == IntPtr.Zero ? "" : WindowOps.EffectiveProcess(root);
            _targetInfo = process.Length == 0 ? title
                : (title.Length > 0 ? title + " (" + process + ")" : process);
            _targetHwnd = root.ToInt64();
            _targetProcess = process;

            string want = _state.CursorWindow ?? "";
            if (want.Length > 0 && !WindowOps.Matches(want, root))
            {
                Abort(false, "The target is in '" + _targetInfo + "', not '" + want
                    + "', so nothing was done.");
                return false;
            }
            string refused = Policy.CheckWindow(root);
            if (refused != null)
            {
                Abort(false, "Refused: " + refused);
                return false;
            }
            return true;
        }

        private void Abort(bool released, string message)
        {
            ReleaseInput();
            _glide = null;
            _realFollows = false;
            _restSince = _clock.Elapsed.TotalMilliseconds;
            _steps = null;
            WriteAck(false, released, message);
        }

        /// <summary>Lets go of any held button and hands the real pointer back.</summary>
        private void ReleaseInput()
        {
            if (_buttonDown)
            {
                RealPointer.Button(_buttonHeld, false);
                _buttonDown = false;
            }
            RestoreReal();
        }

        private void RestoreReal()
        {
            if (!_hasSavedReal) return;
            Native.SetCursorPos(_savedReal.X, _savedReal.Y);
            _hasSavedReal = false;
        }

        private int ReadAckSeq()
        {
            string json = FileUtil.ReadShared(_ackPath);
            if (json == null) return 0;
            long? seq = Json.Int(json, "seq");
            return seq.HasValue ? (int)seq.Value : 0;
        }

        private void WriteAck(bool ok, bool released, string message)
        {
            // One line per command with when each step began, so a slow step can be found later.
            Log("seq " + _commandSeq + " " + _state.CursorAction + " " + (ok ? "ok" : "failed")
                + " total " + (int)(_clock.Elapsed.TotalMilliseconds - _commandStart) + "ms:"
                + _trace + (message.Length > 0 ? " | " + message : ""));

            string json = "{\"seq\": " + _commandSeq.ToString(CultureInfo.InvariantCulture)
                + ", \"ok\": " + Json.B(ok)
                + ", \"released\": " + Json.B(released)
                + ", \"message\": " + Json.Q(message)
                + ", \"window\": " + Json.Q(_targetInfo)
                + ", \"hwnd\": " + Json.N(_targetHwnd)
                + ", \"process\": " + Json.Q(_targetProcess)
                + ", \"wheel_sent\": " + Json.N(_wheelSent) + "}";
            try { FileUtil.WriteAtomic(_ackPath, json); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private static string Elapsed(DateTime started)
        {
            if (started == DateTime.MinValue) return "";
            TimeSpan d = DateTime.Now - started;
            if (d.TotalSeconds < 0) return "";
            if (d.TotalHours >= 1)
                return string.Format(CultureInfo.InvariantCulture, "{0}h {1:00}m",
                    (int)d.TotalHours, d.Minutes);
            return string.Format(CultureInfo.InvariantCulture, "{0}m {1:00}s",
                (int)d.TotalMinutes, d.Seconds);
        }

        /// <summary>Other apps steal the top of the z-order, so claim it back periodically.</summary>
        private void KeepOnTop()
        {
            uint flags = Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE;
            for (int i = 0; i < _edges.Length; i++)
                Native.SetWindowPos(_edges[i].Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, flags);
            Native.SetWindowPos(_cursorWindow.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, flags);
            Native.SetWindowPos(_panel.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, flags);
        }

        private void Quit(Timer timer)
        {
            timer.Stop();
            if (_steps != null) Abort(false, "The overlay was stopped before the pointer command finished.");
            else ReleaseInput();
            if (_hook != IntPtr.Zero)
            {
                Native.UnhookWindowsHookEx(_hook);
                _hook = IntPtr.Zero;
            }
            Application.Exit();
        }
    }

    /// <summary>
    /// A small general JSON reader and writer for the CLI, so it needs neither ConvertFrom-Json
    /// (slow to load) nor ConvertTo-Json (whose files the desktop app's JSON.parse may reject).
    /// Objects become Dictionary&lt;string, object&gt;, arrays List&lt;object&gt;, numbers long or double.
    /// </summary>
    public static class MiniJson
    {
        public static object Parse(string text)
        {
            if (text == null) return null;
            int i = 0;
            if (text.Length > 0 && text[0] == (char)0xFEFF) i = 1;
            object v = Value(text, ref i);
            Ws(text, ref i);
            if (i < text.Length) throw new FormatException("Unexpected text after the JSON value at " + i + ".");
            return v;
        }

        /// <summary>Parses, returning null instead of throwing on missing or malformed input.</summary>
        public static object TryParse(string text)
        {
            try { return Parse(text); }
            catch (FormatException) { return null; }
            catch (ArgumentOutOfRangeException) { return null; }
            catch (IndexOutOfRangeException) { return null; }
        }

        private static void Ws(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        private static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON.");
            char c = s[i];
            if (c == '{')
            {
                Dictionary<string, object> d = new Dictionary<string, object>(StringComparer.Ordinal);
                i++;
                Ws(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return d; }
                while (true)
                {
                    Ws(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new FormatException("Expected a property name at " + i + ".");
                    string key = Str(s, ref i);
                    Ws(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("Expected ':' at " + i + ".");
                    i++;
                    d[key] = Value(s, ref i);
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return d; }
                    throw new FormatException("Expected ',' or '}' at " + i + ".");
                }
            }
            if (c == '[')
            {
                List<object> list = new List<object>();
                i++;
                Ws(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return list; }
                    throw new FormatException("Expected ',' or ']' at " + i + ".");
                }
            }
            if (c == '"') return Str(s, ref i);
            if (string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            string num = s.Substring(start, i - start);
            if (num.Length == 0) throw new FormatException("Unexpected character '" + c + "' at " + start + ".");
            long l;
            if (num.IndexOfAny(new char[] { '.', 'e', 'E' }) < 0
                && long.TryParse(num, NumberStyles.Integer, CultureInfo.InvariantCulture, out l)) return l;
            double dbl;
            if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out dbl)) return dbl;
            throw new FormatException("Bad number '" + num + "'.");
        }

        private static string Str(string s, ref int i)
        {
            i++; // opening quote
            StringBuilder sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char n = s[i++];
                switch (n)
                {
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("Bad \\u escape.");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: sb.Append(n); break;
                }
            }
            throw new FormatException("Unterminated string.");
        }

        /// <summary>Serializes dictionaries, lists, strings, numbers, booleans and null; pretty puts each top-level field on its own line.</summary>
        public static string Serialize(object v, bool pretty)
        {
            StringBuilder sb = new StringBuilder();
            Write(sb, v, pretty ? 0 : -1);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object v, int level)
        {
            if (v == null) { sb.Append("null"); return; }
            if (v is string) { sb.Append(Json.Q((string)v)); return; }
            if (v is char) { sb.Append(Json.Q(v.ToString())); return; }
            if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
            if (v is int || v is long || v is short || v is byte || v is uint || v is ulong || v is ushort || v is sbyte)
            {
                sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                return;
            }
            if (v is double || v is float || v is decimal)
            {
                sb.Append(Json.N(Convert.ToDouble(v, CultureInfo.InvariantCulture)));
                return;
            }
            if (v is DateTime) { sb.Append(Json.Q(((DateTime)v).ToString("o", CultureInfo.InvariantCulture))); return; }
            System.Collections.IDictionary dict = v as System.Collections.IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (System.Collections.DictionaryEntry e in dict)
                {
                    if (!first) sb.Append(',');
                    if (level == 0) sb.Append("\n    ");
                    else if (!first) sb.Append(' ');
                    first = false;
                    sb.Append(Json.Q(Convert.ToString(e.Key, CultureInfo.InvariantCulture))).Append(": ");
                    Write(sb, e.Value, level < 0 ? -1 : level + 1);
                }
                if (level == 0 && !first) sb.Append('\n');
                sb.Append('}');
                return;
            }
            System.Collections.IEnumerable list = v as System.Collections.IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(", ");
                    first = false;
                    Write(sb, item, level < 0 ? -1 : level + 1);
                }
                sb.Append(']');
                return;
            }
            sb.Append(Json.Q(v.ToString()));
        }
    }

    /// <summary>Helpers the CLI calls in a loop, where PowerShell itself would be slow.</summary>
    public static class CliTools
    {
        /// <summary>Whether state.json currently says the person asked for control back.</summary>
        public static bool ReleaseRequested(string statePath)
        {
            string json = FileUtil.ReadShared(statePath);
            bool? r = Json.Bool(json, "release_requested");
            return r.HasValue && r.Value;
        }

        /// <summary>
        /// Waits for the overlay's answer to one pointer command. Returns null on timeout, or
        /// "" at once if the overlay process (overlayPid, when not 0) exits without answering.
        /// </summary>
        public static string WaitForAck(string ackPath, int seq, int timeoutMs, int overlayPid)
        {
            Process overlay = null;
            if (overlayPid > 0)
            {
                try { overlay = Process.GetProcessById(overlayPid); }
                catch (ArgumentException) { }
            }
            Stopwatch sw = Stopwatch.StartNew();
            int polls = 0;
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                string json = FileUtil.ReadShared(ackPath);
                long? s = Json.Int(json, "seq");
                if (s.HasValue && s.Value == seq) return json;
                if (overlay != null && ++polls % 8 == 0)
                {
                    try { if (overlay.HasExited) return ""; }
                    catch (InvalidOperationException) { return ""; }
                }
                Thread.Sleep(25);
            }
            return null;
        }

        /// <summary>The keyboard layout of the thread that owns a window (the foreground window's when zero).</summary>
        public static IntPtr LayoutFor(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) hwnd = Native.GetForegroundWindow();
            uint pid;
            uint thread = hwnd == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(hwnd, out pid);
            return Native.GetKeyboardLayout(thread);
        }
    }
}
