<#
.SYNOPSIS
    Automated self-test for the computer-use skill.

.DESCRIPTION
    Builds a small test window (SelfTestForm.cs, compiled to its own exe), then drives ONLY that
    window through scripts/computer.ps1 exactly as an agent would, one process per command, and
    checks every effect through the JSON state the window writes. It also checks the refusals
    (Windows key, denied processes, config.json), release semantics, the action log and the
    observation file.

    Input tests borrow the real mouse for a fraction of a second at a time and bring the test
    window to the front; keep hands off the mouse and keyboard for the minute or so it runs.
    Everything runs against a temporary state directory, and the overlay and the test window
    are always closed at the end, even on failure.

    Exit code 0 when every check passes, 1 otherwise.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tests\selftest.ps1
#>
[CmdletBinding()]
param(
    # Keep the temporary directory (state, screenshots, logs) for inspection.
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = [IO.Path]::GetFullPath((Join-Path $here '..\scripts\computer.ps1'))
$winps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$temp = Join-Path ([IO.Path]::GetTempPath()) ('atc-computer-use-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stateDir = Join-Path $temp 'state'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$formState = Join-Path $temp 'form.json'
$title = 'ATC Computer Use Self-Test ' + [guid]::NewGuid().ToString('N').Substring(0, 6)

$env:ATC_COMPUTER_USE_DIR = $stateDir
$env:ATC_AGENT_NAME = 'Self-test'
$env:ATC_AGENT_ID = 'selftest-agent'
$env:ATC_SELFTEST_TITLE = $title
$env:ATC_SELFTEST_STATE = $formState

$script:passed = 0
$script:failed = 0
$script:failures = @()

function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) {
        $script:passed++
        Write-Host ("PASS  {0}" -f $name)
    }
    else {
        $script:failed++
        $script:failures += $name
        Write-Host ("FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red
    }
}

function Quote([string]$a) {
    if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
    # Standard Windows command-line quoting: backslashes before a quote are doubled.
    $s = [regex]::Replace($a, '(\\*)"', { param($m) ($m.Groups[1].Value * 2) + '\"' })
    $s = [regex]::Replace($s, '(\\+)$', { param($m) $m.Groups[1].Value * 2 })
    return '"' + $s + '"'
}

<# Runs one computer.ps1 command in its own powershell.exe, as an agent does. #>
function CU {
    $cuArgs = @($args | ForEach-Object { [string]$_ })
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $winps
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File ' + (Quote $cli) + ' ' + (($cuArgs | ForEach-Object { Quote $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.CreateNoWindow = $true
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = [Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(90000)) { try { $p.Kill() } catch { }; throw "computer.ps1 $($cuArgs -join ' ') hung" }
    $p.WaitForExit()
    $r = [pscustomobject]@{ Code = $p.ExitCode; Out = $out.Result; Err = $err.Result; Ms = $sw.ElapsedMilliseconds; Args = ($cuArgs -join ' ') }
    Write-Host ("      computer.ps1 {0}  -> exit {1} ({2} ms)" -f $r.Args, $r.Code, $r.Ms) -ForegroundColor DarkGray
    return $r
}

function Read-Form {
    for ($i = 0; $i -lt 10; $i++) {
        try {
            # Shared read, so the test window can replace the file while it is open here.
            $fs = New-Object IO.FileStream($formState, [IO.FileMode]::Open, [IO.FileAccess]::Read,
                ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try { $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Dispose() }
            return ($text | ConvertFrom-Json)
        }
        catch { Start-Sleep -Milliseconds 50 }
    }
    return $null
}

<# Non-ASCII as \uXXXX, so failure details survive any console code page. #>
function Show([string]$s) {
    if ($null -eq $s) { return '<null>' }
    $b = New-Object Text.StringBuilder
    foreach ($ch in $s.ToCharArray()) {
        if ([int]$ch -lt 32 -or [int]$ch -gt 126) { [void]$b.Append(('\u{0:x4}' -f [int]$ch)) } else { [void]$b.Append($ch) }
    }
    return $b.ToString()
}

<# Waits up to ~3 s for the test window's state to satisfy the condition; returns the last state. #>
function Wait-Form([scriptblock]$condition, [int]$ms = 3000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $s = $null
    do {
        $s = Read-Form
        if ($s -and (& $condition $s)) { return $s }
        Start-Sleep -Milliseconds 100
    } while ($sw.ElapsedMilliseconds -lt $ms)
    return $s
}

function Observe {
    $r = CU state -Window $script:hwnd -Text -Json -MaxElements 500
    if ($r.Code -ne 0) { throw "state failed: $($r.Err)" }
    return ($r.Out | ConvertFrom-Json)
}

function El($obs, [string]$automationId) {
    return ($obs.elements | Where-Object { $_.automationId -eq $automationId } | Select-Object -First 1)
}

function Center($el) {
    return @([int][Math]::Floor($el.rect.x + $el.rect.width / 2), [int][Math]::Floor($el.rect.y + $el.rect.height / 2))
}

$probe = $null
try {
    Write-Host "self-test: state dir $stateDir"

    # --- Build the test window --------------------------------------------------------------
    $exe = Join-Path $temp 'ComputerUseSelfTest.exe'
    Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $here 'SelfTestForm.cs'))) -Language CSharp `
        -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -OutputAssembly $exe -OutputType WindowsApplication
    Check 'test window compiled' (Test-Path $exe)

    # --- Non-invasive commands --------------------------------------------------------------
    $r = CU help
    Check 'help exits 0' ($r.Code -eq 0 -and $r.Out -match 'set-value')
    $r = CU status -Json
    Check 'status -Json before any session' ($r.Code -eq 0 -and ($r.Out | ConvertFrom-Json).active -eq $false)
    $r = CU policy -Json
    $pol = $r.Out | ConvertFrom-Json
    Check 'policy lists the built-in deny list' ($r.Code -eq 0 -and $pol.builtinDenied -contains 'WindowsTerminal' -and $pol.builtinDenied -contains 'claude')
    $r = CU bogus-command
    Check 'unknown command exits 2' ($r.Code -eq 2)
    $r = CU click -X notanumber -Y 5
    Check 'bad number exits 2' ($r.Code -eq 2)

    # --- launch -----------------------------------------------------------------------------
    $r = CU launch -App 'KeePassXC'
    Check 'launch refuses a denied app' ($r.Code -eq 4 -and $r.Err -match 'deny')
    $r = CU launch -App $exe -TimeoutSeconds 20
    Check 'launch starts the test window' ($r.Code -eq 0 -and $r.Out -match 'hwnd=(\d+)') $r.Err
    if ($r.Out -notmatch 'hwnd=(\d+)') { throw 'The test window did not start; cannot continue.' }
    $script:hwnd = $Matches[1]
    $null = Wait-Form { param($s) $true }

    $r = CU apps -Json
    $apps = $r.Out | ConvertFrom-Json
    $mine = $apps | Where-Object { $_.process -eq 'ComputerUseSelfTest' }
    Check 'apps -Json lists the test app with its window' ($r.Code -eq 0 -and $mine -and ($mine.windows | Where-Object { [string]$_.hwnd -eq $script:hwnd }) -and $mine.path -like '*ComputerUseSelfTest.exe')
    $r = CU windows -Window $title
    Check 'windows finds the test window by title' ($r.Code -eq 0 -and $r.Out -match "hwnd=$($script:hwnd)")

    # --- activate (from minimized) ----------------------------------------------------------
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -Namespace SelfTest -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@
    $h = [IntPtr][long]$script:hwnd
    [void][SelfTest.Win]::ShowWindow($h, 6)  # SW_MINIMIZE
    Start-Sleep -Milliseconds 400
    $r = CU activate -Window $script:hwnd
    Check 'activate restores and brings the window to the front' ($r.Code -eq 0 -and -not [SelfTest.Win]::IsIconic($h) -and [SelfTest.Win]::GetForegroundWindow() -eq $h) "$($r.Out) $($r.Err)"

    # --- state ------------------------------------------------------------------------------
    $obs = Observe
    $btn = El $obs 'btnInc'; $txt = El $obs 'txtInput'; $chk = El $obs 'chkBox'; $cmb = El $obs 'cmbChoice'
    $lst = El $obs 'lstItems'; $pad = El $obs 'clickPad'; $drag = El $obs 'dragPad'
    Check 'state -Text numbers the test controls' ($btn -and $txt -and $chk -and $cmb -and $lst -and $pad -and $drag)
    Check 'state reports actions per element' ($btn.actions -contains 'invoke' -and $chk.actions -contains 'toggle' -and $cmb.actions -contains 'expand' -and $txt.actions -contains 'set-value') "btn=$($btn.actions -join ',') chk=$($chk.actions -join ',') cmb=$($cmb.actions -join ',') txt=$($txt.controlType):$($txt.actions -join ',')"
    Check 'state saved a PNG of the window' ($obs.image -and (Test-Path $obs.image.path) -and $obs.image.capture -eq 'printwindow')
    $lo = Get-Content (Join-Path $stateDir 'last_observation.json') -Raw | ConvertFrom-Json
    Check 'last_observation.json has window, image and element map' ([string]$lo.window.hwnd -eq $script:hwnd -and $null -ne $lo.image.originX -and $lo.image.zoom -gt 0 -and $lo.elements.Count -gt 7 -and $lo.elements[0].runtimeId)
    $r = CU state -Window $script:hwnd
    Check 'state (text output) prints origin and zoom' ($r.Code -eq 0 -and $r.Out -match 'origin x=' -and $r.Out -match 'zoom')
    $obs = Observe   # element indexes again belong to the latest observation

    # --- click ------------------------------------------------------------------------------
    $r = CU click -Element $btn.index
    $s = Wait-Form { param($s) $s.count -eq 1 }
    Check 'click -Element pressed the button (auto-started overlay)' ($r.Code -eq 0 -and $s.count -eq 1) "$($r.Err) count=$($s.count)"
    $st = Get-Content (Join-Path $stateDir 'state.json') -Raw | ConvertFrom-Json
    Check 'state.json: active, auto-started, agent name and id from the environment' ($st.active -and $st.auto_started -and $st.agent -eq 'Self-test' -and $st.agent_id -eq 'selftest-agent')
    $pidText = Get-Content (Join-Path $stateDir 'overlay.pid') -Raw -ErrorAction SilentlyContinue
    Check 'overlay.pid names a running overlay' ($pidText -and (Get-Process -Id ([int]$pidText.Trim()) -ErrorAction SilentlyContinue))
    $log = Get-Content (Join-Path $stateDir 'overlay.log') -Raw -ErrorAction SilentlyContinue
    Check 'overlay installed the Escape hook' ($log -match 'escape hook installed') $log

    $ix = [int][Math]::Floor(($btn.rect.x + $btn.rect.width / 2 - $obs.image.originX) * $obs.image.zoom)
    $iy = [int][Math]::Floor(($btn.rect.y + $btn.rect.height / 2 - $obs.image.originY) * $obs.image.zoom)
    $r = CU click -Image -X $ix -Y $iy
    $s = Wait-Form { param($s) $s.count -eq 2 }
    Check 'click -Image maps image pixels to the screen' ($r.Code -eq 0 -and $s.count -eq 2) "$($r.Err) count=$($s.count)"

    $pc = Center $pad
    $r = CU click -X $pc[0] -Y $pc[1] -Window $script:hwnd -Count 2
    $s = Wait-Form { param($s) $s.lastClicks -eq 2 }
    Check 'click -Count 2 is a double-click' ($r.Code -eq 0 -and $s.lastClicks -eq 2) "$($r.Err) lastClicks=$($s.lastClicks)"
    $r = CU click -X $pc[0] -Y $pc[1] -Window $title -Button Right
    $s = Wait-Form { param($s) $s.rightDowns -eq 1 }
    Check 'click -Button Right' ($r.Code -eq 0 -and $s.rightDowns -eq 1) $r.Err
    $r = CU click -X $pc[0] -Y $pc[1] -Window $script:hwnd -Button Middle
    $s = Wait-Form { param($s) $s.middleDowns -eq 1 }
    Check 'click -Button Middle' ($r.Code -eq 0 -and $s.middleDowns -eq 1) $r.Err

    # --- type and key -----------------------------------------------------------------------
    $r = CU click -Element $txt.index
    $typed = "h$([char]0xE9)llo w$([char]0xF6)rld $([char]0xD83D)$([char]0xDE00)`nline2"
    $r = CU type -Text $typed -Window $script:hwnd
    $want = $typed.Replace("`n", "`r`n")
    $s = Wait-Form { param($s) $s.text -eq $want }
    Check 'type: Unicode, a surrogate pair, and a newline as Enter' ($r.Code -eq 0 -and $s.text -eq $want) "$($r.Err) got '$(Show $s.text)'"
    $r = CU key -Keys 'Control_L+a' -Window $script:hwnd
    $r2 = CU key -Keys 'BackSpace' -Window $script:hwnd
    $s = Wait-Form { param($s) $s.text -eq '' }
    Check 'key Control_L+a then BackSpace clears the text' ($r.Code -eq 0 -and $r2.Code -eq 0 -and $s.text -eq '' -and $s.keys -contains 'Control+A') "text='$($s.text)' keys=$($s.keys -join ',')"
    $r = CU key -Keys 'KP_5' -Window $script:hwnd -Repeat 2
    $s = Wait-Form { param($s) ($s.keys | Where-Object { $_ -eq 'NumPad5' }).Count -ge 2 }
    Check 'key KP_5 -Repeat 2 sends the keypad key twice' ($r.Code -eq 0 -and ($s.keys | Where-Object { $_ -eq 'NumPad5' }).Count -ge 2) ($s.keys -join ',')
    $r = CU key -Keys 'ctrl + shift + period' -Window $script:hwnd
    $s = Wait-Form { param($s) $s.keys -contains 'Shift+Control+OemPeriod' }
    Check 'key with aliases and spaces (ctrl + shift + period)' ($r.Code -eq 0 -and $s.keys -contains 'Shift+Control+OemPeriod') ($s.keys -join ',')
    $r = CU key -Keys 'Super_L' -Window $script:hwnd
    Check 'key refuses the Windows key (Super_L)' ($r.Code -eq 4 -and $r.Err -match 'Windows key')
    $r = CU key -Keys 'Win+r'
    Check 'key refuses Win+r' ($r.Code -eq 4)
    $r = CU key -Keys 'NoSuchKey' -Window $script:hwnd
    Check 'key rejects an unknown key name with exit 2' ($r.Code -eq 2)

    # An injected Escape must not count as the person taking control back.
    $r = CU key -Keys 'Escape' -Window $script:hwnd
    $s = Wait-Form { param($s) $s.keys -contains 'Escape' }
    $st = CU status -Json
    Check 'injected Escape reaches the app and does not release' ($r.Code -eq 0 -and $s.keys -contains 'Escape' -and $st.Code -eq 0 -and -not ($st.Out | ConvertFrom-Json).release_requested)

    # --- scroll and drag --------------------------------------------------------------------
    $r = CU scroll -Element $lst.index -ScrollY 3
    $s = Wait-Form { param($s) $s.listTop -gt 0 }
    $top = $s.listTop
    Check 'scroll -ScrollY 3 scrolls the list down' ($r.Code -eq 0 -and $top -gt 0) "$($r.Err) top=$top"
    $r = CU scroll -Element $lst.index -ScrollY -1
    $s = Wait-Form { param($s) $s.listTop -lt $top }
    Check 'scroll -ScrollY -1 scrolls back up' ($r.Code -eq 0 -and $s.listTop -lt $top) "top=$($s.listTop)"

    $d = Center $drag
    $fromX = [int]($drag.rect.x + 60); $toX = [int]($drag.rect.x + $drag.rect.width - 60)
    $r = CU drag -X $fromX -Y $d[1] -ToX $toX -ToY $d[1] -Window $script:hwnd
    $s = Wait-Form { param($s) $s.dragToX -ge 0 }
    $moved = $s.dragToX - $s.dragFromX
    Check 'drag holds the button across the pad' ($r.Code -eq 0 -and [Math]::Abs($moved - ($toX - $fromX)) -le 3 -and $s.dragMoves -gt 3) "moved=$moved want=$($toX - $fromX) moves=$($s.dragMoves)"

    # --- UI Automation actions --------------------------------------------------------------
    $r = CU set-value -Element $txt.index -Value 'set by uia'
    $s = Wait-Form { param($s) $s.text -eq 'set by uia' }
    Check 'set-value writes the text box' ($r.Code -eq 0 -and $s.text -eq 'set by uia') "$($r.Err) text='$($s.text)'"
    $before = (Read-Form).count
    $r = CU invoke -Element $btn.index
    $s = Wait-Form { param($s) $s.count -eq $before + 1 }
    Check 'invoke presses the button' ($r.Code -eq 0 -and $s.count -eq $before + 1) $r.Err
    $r = CU invoke -Element $chk.index -Pattern Toggle
    $s = Wait-Form { param($s) $s.checked }
    Check 'invoke -Pattern Toggle checks the box' ($r.Code -eq 0 -and $s.checked) $r.Err
    $r = CU invoke -Element $cmb.index -Pattern Expand
    $s = Wait-Form { param($s) $s.dropdowns -ge 1 }
    $r2 = CU invoke -Element $cmb.index -Pattern Collapse
    Check 'invoke -Pattern Expand / Collapse on the combo box' ($r.Code -eq 0 -and $r2.Code -eq 0 -and $s.dropdowns -ge 1) "$($r.Err) $($r2.Err)"
    $item = $obs.elements | Where-Object { $_.name -eq 'Item 150' } | Select-Object -First 1
    $r = CU invoke -Element $item.index -Pattern Select
    $s = Wait-Form { param($s) $s.listSelected -eq 150 }
    Check 'invoke -Pattern Select picks a list item' ($r.Code -eq 0 -and $s.listSelected -eq 150) "$($r.Err) selected=$($s.listSelected)"
    $r = CU invoke -Element $btn.index -Pattern Toggle
    Check 'invoke with an unsupported pattern is refused with exit 4' ($r.Code -eq 4 -and $r.Err -match 'does not support')

    # --- guards and policy ------------------------------------------------------------------
    $before = (Read-Form).count
    $bc = Center $btn
    $r = CU click -X $bc[0] -Y $bc[1] -Window 'No Such Window Title'
    Check 'click refuses when the point is not in the named window' ($r.Code -eq 4 -and (Read-Form).count -eq $before)

    $probe = New-Object System.Windows.Forms.Form
    $probe.Text = 'ATC deny probe'
    $probeHandle = $probe.Handle.ToInt64()   # a real window owned by this powershell.exe
    $r = CU click -X $bc[0] -Y $bc[1] -Window $probeHandle
    Check 'click whose -Window is a powershell window is refused' ($r.Code -eq 4 -and $r.Err -match 'powershell' -and (Read-Form).count -eq $before) $r.Err
    $r = CU type -Text 'x' -Window $probeHandle
    Check 'type into a powershell window is refused' ($r.Code -eq 4 -and $r.Err -match 'deny')

    $config = Join-Path $stateDir 'config.json'
    Set-Content -Path $config -Value '{ "allowedProcesses": [], "deniedProcesses": ["ComputerUseSelfTest.exe"] }' -Encoding UTF8
    $r = CU click -Element $btn.index
    Check 'config.json deniedProcesses refuses the app' ($r.Code -eq 4 -and $r.Err -match 'deniedProcesses' -and (Read-Form).count -eq $before) $r.Err
    [IO.File]::WriteAllText($config, '{ "allowedProcesses": ["notepad"], "deniedProcesses": [] }')
    $r = CU invoke -Element $btn.index
    Check 'config.json allowedProcesses refuses anything not listed' ($r.Code -eq 4 -and $r.Err -match 'allowedProcesses' -and (Read-Form).count -eq $before) $r.Err
    [IO.File]::WriteAllText($config, '{ "allowedProcesses": ["ComputerUseSelfTest"], "deniedProcesses": [] }')
    $r = CU click -Element $btn.index
    $s = Wait-Form { param($s) $s.count -eq $before + 1 }
    Check 'config.json allowedProcesses admits a listed app' ($r.Code -eq 0 -and $s.count -eq $before + 1) $r.Err
    Remove-Item $config -Force

    # --- the overlay stays out of screenshots -----------------------------------------------
    $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $shot = Join-Path $temp 'panel.png'
    $r = CU screenshot -X $scr.X -Y $scr.Y -Width $scr.Width -Height ([int]($scr.Height * 0.2)) -Out $shot
    $orange = 0
    if (Test-Path $shot) {
        Add-Type -AssemblyName System.Drawing
        $bmp = [System.Drawing.Bitmap]::FromFile($shot)
        try {
            for ($yy = 0; $yy -lt $bmp.Height; $yy += 2) {
                for ($xx = [int]($bmp.Width * 0.25); $xx -lt [int]($bmp.Width * 0.75); $xx += 2) {
                    $c = $bmp.GetPixel($xx, $yy)
                    if ([Math]::Abs($c.R - 255) -lt 6 -and [Math]::Abs($c.G - 154) -lt 6 -and [Math]::Abs($c.B - 31) -lt 6) { $orange++ }
                }
            }
        }
        finally { $bmp.Dispose() }
    }
    Check 'the overlay panel is not in screenshots' ($r.Code -eq 0 -and (Test-Path $shot) -and $orange -lt 20) "orange pixels: $orange"

    # --- release ----------------------------------------------------------------------------
    $before = (Read-Form).count
    $r = CU release
    Check 'release exits 0' ($r.Code -eq 0)
    $st = Get-Content (Join-Path $stateDir 'state.json') -Raw | ConvertFrom-Json
    Check 'release sets release_requested in state.json' ($st.release_requested -eq $true -and $st.release_source -eq 'command')
    $r = CU click -Element $btn.index
    Check 'after release, click exits 3 and does nothing' ($r.Code -eq 3 -and (Read-Form).count -eq $before) $r.Err
    $r = CU key -Keys Tab -Window $script:hwnd
    Check 'after release, key exits 3' ($r.Code -eq 3)
    $r = CU windows
    Check 'after release, windows exits 3' ($r.Code -eq 3)
    $r = CU status
    Check 'after release, status exits 3' ($r.Code -eq 3)
    $r = CU stop
    Check 'stop exits 0' ($r.Code -eq 0)
    $r = CU status -Json
    Check 'after stop, status is inactive and not released' ($r.Code -eq 0 -and -not ($r.Out | ConvertFrom-Json).active)
    $r = CU click -Element $btn.index
    $s = Wait-Form { param($s) $s.count -eq $before + 1 }
    Check 'after stop, the next input command starts a new session' ($r.Code -eq 0 -and $s.count -eq $before + 1) $r.Err

    # --- action log -------------------------------------------------------------------------
    $lines = @(Get-Content (Join-Path $stateDir 'actions.jsonl') -Encoding UTF8)
    $records = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
    $typeRec = $records | Where-Object { $_.command -eq 'type' -and $_.code -eq 0 } | Select-Object -First 1
    Check 'actions.jsonl has one JSON record per command' ($records.Count -ge 35 -and ($records | Where-Object { -not $_.timestamp -or -not $_.command -or $null -eq $_.code }).Count -eq 0) "records=$($records.Count)"
    Check 'actions.jsonl records the typed length, never the text' ($typeRec.args -match 'length=' -and ($lines -join "`n") -notmatch 'llo w' -and ($lines -join "`n") -notmatch 'set by uia')
    Check 'actions.jsonl names the agent and target' ($typeRec.agent -eq 'Self-test' -and $typeRec.agent_id -eq 'selftest-agent' -and $typeRec.process -eq 'ComputerUseSelfTest')
    $refused = $records | Where-Object { $_.code -eq 4 -and $_.message -match 'deniedProcesses' }
    Check 'actions.jsonl records refusals with their reason' ([bool]$refused)
}
catch {
    Check 'self-test ran to completion' $false $_.Exception.Message
    Write-Host $_.ScriptStackTrace
}
finally {
    $r = CU stop
    if ($probe) { $probe.Dispose() }
    $p = Get-Process -Name 'ComputerUseSelfTest' -ErrorAction SilentlyContinue
    foreach ($x in $p) { try { [void]$x.CloseMainWindow(); if (-not $x.WaitForExit(3000)) { $x.Kill() } } catch { } }
    Start-Sleep -Milliseconds 300
    $overlayPid = Get-Content (Join-Path $stateDir 'overlay.pid') -Raw -ErrorAction SilentlyContinue
    Check 'no overlay left running' (-not $overlayPid)
    Check 'test window closed' (-not (Get-Process -Name 'ComputerUseSelfTest' -ErrorAction SilentlyContinue))
    foreach ($name in 'ATC_COMPUTER_USE_DIR', 'ATC_AGENT_NAME', 'ATC_AGENT_ID', 'ATC_SELFTEST_TITLE', 'ATC_SELFTEST_STATE') {
        Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
    }
    if ($script:failed -eq 0 -and -not $KeepTemp) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
    else { Write-Host "self-test: files kept in $temp" }
    Write-Host ''
    Write-Host ("self-test: {0} passed, {1} failed" -f $script:passed, $script:failed)
    if ($script:failed -gt 0) { Write-Host ('failed: ' + ($script:failures -join '; ')) -ForegroundColor Red }
}
if ($script:failed -gt 0) { exit 1 }
exit 0
