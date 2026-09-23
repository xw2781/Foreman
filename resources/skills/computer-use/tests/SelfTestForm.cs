// The self-test's target window: a small WinForms app, compiled to its own exe so that its
// process is not powershell (which the app policy always refuses). Every change it sees is
// written to a JSON file, so selftest.ps1 can check what each command really did.
// C# 5 and ASCII, for the compiler that ships with Windows PowerShell 5.1.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class SelfTestForm : Form
{
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    private readonly string _statePath;
    private readonly TextBox _text = new TextBox();
    private readonly Button _button = new Button();
    private readonly Label _label = new Label();
    private readonly CheckBox _check = new CheckBox();
    private readonly ComboBox _combo = new ComboBox();
    private readonly ListBox _list = new ListBox();
    private readonly Panel _clickPad = new Panel();
    private readonly Panel _dragPad = new Panel();
    private readonly List<string> _keys = new List<string>();
    private int _count, _left, _right, _middle, _lastClicks, _dropdowns, _dragMoves, _lastTop = -1;
    private Point _dragFrom = new Point(-1, -1), _dragTo = new Point(-1, -1);
    private bool _dragging;

    public SelfTestForm(string title, string statePath)
    {
        _statePath = statePath;
        Text = title;
        AutoScaleMode = AutoScaleMode.None;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(100, 330);
        ClientSize = new Size(760, 620);
        TopMost = true;
        KeyPreview = true;
        Font = new Font("Segoe UI", 11f);

        _text.Name = "txtInput";
        _text.Multiline = true;
        _text.AcceptsReturn = true;
        _text.ScrollBars = ScrollBars.Vertical;
        _text.SetBounds(20, 20, 420, 110);
        _text.TextChanged += delegate { Save(); };

        _button.Name = "btnInc";
        _button.Text = "Increment";
        _button.SetBounds(20, 150, 160, 50);
        _button.Click += delegate { _count++; _label.Text = "Count: " + _count; Save(); };

        _label.Name = "lblCount";
        _label.Text = "Count: 0";
        _label.SetBounds(200, 160, 200, 36);

        _check.Name = "chkBox";
        _check.Text = "Check me";
        _check.SetBounds(20, 220, 200, 36);
        _check.CheckedChanged += delegate { Save(); };

        _combo.Name = "cmbChoice";
        _combo.DropDownStyle = ComboBoxStyle.DropDownList;
        _combo.Items.AddRange(new object[] { "Alpha", "Beta", "Gamma" });
        _combo.SetBounds(240, 220, 200, 36);
        _combo.DropDown += delegate { _dropdowns++; Save(); };
        _combo.SelectedIndexChanged += delegate { Save(); };

        _list.Name = "lstItems";
        _list.IntegralHeight = false;
        _list.SetBounds(460, 20, 280, 300);
        for (int i = 0; i < 200; i++) _list.Items.Add("Item " + i.ToString("000", CultureInfo.InvariantCulture));
        _list.SelectedIndexChanged += delegate { Save(); };

        _clickPad.Name = "clickPad";
        _clickPad.BackColor = Color.LightSkyBlue;
        _clickPad.SetBounds(20, 280, 420, 120);
        _clickPad.MouseDown += delegate (object s, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) _left++;
            else if (e.Button == MouseButtons.Right) _right++;
            else if (e.Button == MouseButtons.Middle) _middle++;
            _lastClicks = e.Clicks;
            Save();
        };

        _dragPad.Name = "dragPad";
        _dragPad.BackColor = Color.PaleGreen;
        _dragPad.SetBounds(20, 420, 720, 180);
        _dragPad.MouseDown += delegate (object s, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            _dragging = true;
            _dragFrom = e.Location;
            _dragMoves = 0;
            Save();
        };
        _dragPad.MouseMove += delegate (object s, MouseEventArgs e) { if (_dragging) _dragMoves++; };
        _dragPad.MouseUp += delegate (object s, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left || !_dragging) return;
            _dragging = false;
            _dragTo = e.Location;
            Save();
        };

        KeyDown += delegate (object s, KeyEventArgs e)
        {
            string mods = e.Modifiers == Keys.None ? "" : e.Modifiers.ToString().Replace(", ", "+") + "+";
            _keys.Add(mods + e.KeyCode);
            if (_keys.Count > 40) _keys.RemoveAt(0);
            Save();
        };

        Timer poll = new Timer();
        poll.Interval = 100;
        poll.Tick += delegate
        {
            if (_list.TopIndex != _lastTop) { _lastTop = _list.TopIndex; Save(); }
        };
        poll.Start();

        Controls.AddRange(new Control[] { _text, _button, _label, _check, _combo, _list, _clickPad, _dragPad });
        Shown += delegate { Save(); };
    }

    private static string Q(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char ch in s ?? "")
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < ' ' || ch > '~') sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }

    private void Save()
    {
        StringBuilder sb = new StringBuilder("{");
        sb.Append("\"text\": ").Append(Q(_text.Text));
        sb.Append(", \"count\": ").Append(_count);
        sb.Append(", \"checked\": ").Append(_check.Checked ? "true" : "false");
        sb.Append(", \"comboIndex\": ").Append(_combo.SelectedIndex);
        sb.Append(", \"dropdowns\": ").Append(_dropdowns);
        sb.Append(", \"listTop\": ").Append(_list.TopIndex);
        sb.Append(", \"listSelected\": ").Append(_list.SelectedIndex);
        sb.Append(", \"leftDowns\": ").Append(_left);
        sb.Append(", \"rightDowns\": ").Append(_right);
        sb.Append(", \"middleDowns\": ").Append(_middle);
        sb.Append(", \"lastClicks\": ").Append(_lastClicks);
        sb.Append(", \"dragFromX\": ").Append(_dragFrom.X).Append(", \"dragFromY\": ").Append(_dragFrom.Y);
        sb.Append(", \"dragToX\": ").Append(_dragTo.X).Append(", \"dragToY\": ").Append(_dragTo.Y);
        sb.Append(", \"dragMoves\": ").Append(_dragMoves);
        sb.Append(", \"keys\": [");
        for (int i = 0; i < _keys.Count; i++) sb.Append(i > 0 ? ", " : "").Append(Q(_keys[i]));
        sb.Append("]}");
        // The self-test reads this file often; retry rather than lose a state while it is open.
        string tmp = _statePath + ".tmp";
        for (int attempt = 0; attempt < 50; attempt++)
        {
            try
            {
                File.WriteAllText(tmp, sb.ToString());
                if (File.Exists(_statePath)) File.Replace(tmp, _statePath, null);
                else File.Move(tmp, _statePath);
                return;
            }
            catch (IOException) { System.Threading.Thread.Sleep(10); }
            catch (UnauthorizedAccessException) { System.Threading.Thread.Sleep(10); }
        }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        Application.EnableVisualStyles();
        string title = Environment.GetEnvironmentVariable("ATC_SELFTEST_TITLE");
        string state = Environment.GetEnvironmentVariable("ATC_SELFTEST_STATE");
        if (string.IsNullOrEmpty(title)) title = "ATC Computer Use Self-Test";
        if (string.IsNullOrEmpty(state)) state = Path.Combine(Path.GetTempPath(), "atc-computer-use-selftest.json");
        Application.Run(new SelfTestForm(title, state));
    }
}
