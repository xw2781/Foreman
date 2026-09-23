<#
.SYNOPSIS
    Computer use for AI agents on Windows: see desktop apps and carefully drive them.

.DESCRIPTION
    The single entry point for every command. Run `computer.ps1 help` for the list; the full
    reference is ../docs/reference.md.

        powershell -NoProfile -ExecutionPolicy Bypass -File computer.ps1 <command> [options]

    Exit codes: 0 done; 2 bad arguments (or `action` before `start`); 3 the person took back
    control, so stop at once; 4 refused or failed (the message on stderr says why).

    While an agent drives, a hidden helper process draws a glow along the screen edges, the
    agent's own pointer, and an always-on-top panel. The person can take back control with the
    panel's Release button or by pressing Escape; every later command then exits 3.

    Arguments are parsed by hand rather than by a param() block, so that -Text can be a switch
    for `state` and a value for `type`, and so values may begin with '-' (-ScrollY -3).
#>

$ErrorActionPreference = 'Stop'

# Output is UTF-8 so window titles survive a pipe; this must happen before anything is written.
$script:SavedEncoding = $null
try {
    $script:SavedEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}
catch { }

$WinPS = [IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\powershell.exe')

# The helper compiles with Windows PowerShell 5.1; from PowerShell 7, run the command there.
if ($PSVersionTable.PSEdition -eq 'Core') {
    & $WinPS -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @args
    exit $LASTEXITCODE
}

$StateDir = if ($env:ATC_COMPUTER_USE_DIR) { $env:ATC_COMPUTER_USE_DIR } else {
    [IO.Path]::Combine($env:APPDATA, 'AgentTaskCenter\computer-use')
}
$BinDir = [IO.Path]::Combine($env:LOCALAPPDATA, 'AgentTaskCenter\computer-use\bin')

$script:Code = 0
$script:Message = ''
$script:LogThis = $true
$script:LogArgs = ''
$script:LogWindow = ''
$script:LogProcess = ''
$script:LogHwnd = 0
$script:Started = [Diagnostics.Stopwatch]::StartNew()
$script:Opt = @{}
$script:Command = $null

# ---------------------------------------------------------------------------------------------
# Output and exit
# ---------------------------------------------------------------------------------------------

function Say([string]$text) { [Console]::Out.WriteLine($text) }

function JsonText([string]$s) {
    if ($null -eq $s) { return 'null' }
    $b = [System.Text.StringBuilder]::new()
    [void]$b.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        $c = [int]$ch
        if ($ch -eq '"') { [void]$b.Append('\"') }
        elseif ($ch -eq '\') { [void]$b.Append('\\') }
        elseif ($c -lt 32 -or $c -gt 126) { [void]$b.Append(('\u{0:x4}' -f $c)) }
        else { [void]$b.Append($ch) }
    }
    [void]$b.Append('"')
    return $b.ToString()
}

<# Ends the command: code 0 prints the message on stdout, anything else on stderr. #>
function Quit([int]$code, [string]$message) {
    $script:Code = $code
    $script:Message = $message
    if ($message) {
        if ($code -eq 0) { Say $message }
        else {
            [Console]::Error.WriteLine('computer-use: ' + $message)
            if ($script:Opt['json']) {
                Say ('{"ok": false, "code": ' + $code + ', "message": ' + (JsonText $message) + '}')
            }
        }
    }
    exit $code
}

# ---------------------------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------------------------

$KnownCommands = @('help', 'apps', 'windows', 'launch', 'activate', 'state', 'screenshot', 'start',
    'action', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'set-value', 'invoke', 'release',
    'stop', 'status', 'policy', 'demo', 'overlay')
$CommandAliases = @{ 'setvalue' = 'set-value'; 'set_value' = 'set-value'; 'press' = 'key';
    'keys' = 'key'; 'observe' = 'state'; 'list' = 'apps'; '-h' = 'help'; '--help' = 'help'; '/?' = 'help' }
$ValueOptions = @{
    'action' = 'action'; 'agent' = 'agent'; 'color' = 'color'; 'position' = 'position'
    'x' = 'x'; 'y' = 'y'; 'tox' = 'tox'; 'toy' = 'toy'; 'button' = 'button'; 'count' = 'count'
    'clickcount' = 'count'; 'window' = 'window'; 'element' = 'element'; 'index' = 'element'
    'timeoutseconds' = 'timeoutseconds'; 'timeout' = 'timeoutseconds'; 'out' = 'out'
    'width' = 'width'; 'height' = 'height'; 'zoom' = 'zoom'; 'thickness' = 'thickness'
    'idleexitminutes' = 'idleexitminutes'; 'app' = 'app'; 'keys' = 'keys'; 'key' = 'keys'
    'repeat' = 'repeat'; 'scrollx' = 'scrollx'; 'scrolly' = 'scrolly'; 'value' = 'value'
    'pattern' = 'pattern'; 'maxelements' = 'maxelements'; 'textfile' = 'textfile'
    'delayms' = 'delayms'; 'statedir' = 'statedir'
}
$SwitchOptions = @{ 'image' = 'image'; 'json' = 'json'; 'noshot' = 'noshot'; 'nocursor' = 'nocursor'
    'noedges' = 'noedges'; 'help' = 'help' }

function Parse-Arguments([object[]]$argv) {
    $i = 0
    while ($i -lt $argv.Count) {
        $a = [string]$argv[$i]
        $i++
        if (-not $script:Command) {
            $lower = $a.ToLowerInvariant()
            if ($CommandAliases.ContainsKey($lower)) { $lower = $CommandAliases[$lower] }
            if ($KnownCommands -contains $lower) { $script:Command = $lower; continue }
            if ($a -notmatch '^-') { Quit 2 "Unknown command '$a'. Run 'computer.ps1 help' for the list." }
        }
        if ($a -match '^--?([A-Za-z][A-Za-z0-9_-]*)(:(.*))?$') {
            $name = ($Matches[1].ToLowerInvariant() -replace '[-_]', '')
            $hasInline = [bool]$Matches[2]
            $inline = [string]$Matches[3]
            if ($name -eq 'text' -and $script:Command -ne 'type') { $script:Opt['text'] = $true; continue }
            $key = $null
            if ($name -eq 'text') { $key = 'text' }
            elseif ($SwitchOptions.ContainsKey($name)) {
                $script:Opt[$SwitchOptions[$name]] = -not ($hasInline -and $inline -match '^(false|\$false|0)$')
                continue
            }
            elseif ($ValueOptions.ContainsKey($name)) { $key = $ValueOptions[$name] }
            else { Quit 2 "Unknown option '$a'. Run 'computer.ps1 help' for the options." }
            if ($hasInline -and $inline.Length -gt 0) { $script:Opt[$key] = $inline; continue }
            if ($i -ge $argv.Count) { Quit 2 "Option '$a' needs a value." }
            $script:Opt[$key] = [string]$argv[$i]
            $i++
            continue
        }
        Quit 2 "Unexpected argument '$a'. Values go after an option, e.g. -Text 'hello'."
    }
    if (-not $script:Command) { $script:Command = if ($argv.Count -eq 0) { 'status' } else { 'help' } }
}

function OptStr([string]$name, [string]$default = '') {
    if ($script:Opt.ContainsKey($name)) { return [string]$script:Opt[$name] }
    return $default
}

function Has([string]$name) { return $script:Opt.ContainsKey($name) }

function OptInt([string]$name, [int]$default, [string]$label) {
    if (-not $script:Opt.ContainsKey($name)) { return $default }
    $v = 0
    if (-not [int]::TryParse([string]$script:Opt[$name], [Globalization.NumberStyles]::Integer,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) {
        Quit 2 "-$label must be a whole number, not '$($script:Opt[$name])'."
    }
    return $v
}

function OptDouble([string]$name, [double]$default, [string]$label) {
    if (-not $script:Opt.ContainsKey($name)) { return $default }
    $v = 0.0
    if (-not [double]::TryParse([string]$script:Opt[$name], [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) {
        Quit 2 "-$label must be a number, not '$($script:Opt[$name])'."
    }
    return $v
}

function Need-Int([string]$name, [string]$label) {
    if (-not $script:Opt.ContainsKey($name)) { Quit 2 "-$label is required for $script:Command." }
    return (OptInt $name 0 $label)
}

# ---------------------------------------------------------------------------------------------
# The compiled helper: built once per source version, then loaded from the cache
# ---------------------------------------------------------------------------------------------

function Import-ScreenControl {
    if ('AgentTaskCenter.ScreenControl.Native' -as [type]) { return }
    $srcPath = [IO.Path]::Combine($PSScriptRoot, 'AgentScreenControl.cs')
    $bytes = [IO.File]::ReadAllBytes($srcPath)
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').Substring(0, 16).ToLowerInvariant()
    $dll = [IO.Path]::Combine($BinDir, "AgentScreenControl-$hash.dll")
    if (-not [IO.File]::Exists($dll)) {
        [void][IO.Directory]::CreateDirectory($BinDir)
        $tmp = [IO.Path]::Combine($BinDir, "AgentScreenControl-$hash-$PID.tmp.dll")
        $refs = @('System.Windows.Forms', 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')
        Add-Type -TypeDefinition ([Text.Encoding]::ASCII.GetString($bytes)) -Language CSharp `
            -ReferencedAssemblies $refs -OutputAssembly $tmp -OutputType Library
        try { [IO.File]::Move($tmp, $dll) }
        catch {
            # Another process compiled the same source first; its copy is just as good.
            if (-not [IO.File]::Exists($dll)) { throw }
        }
        if ([IO.File]::Exists($tmp)) { try { [IO.File]::Delete($tmp) } catch { } }
        # Older builds are unused once the source changes; a loaded one is simply left behind.
        foreach ($old in [IO.Directory]::GetFiles($BinDir, 'AgentScreenControl-*.dll')) {
            if ($old -ne $dll -and $old -notlike '*.tmp.dll') { try { [IO.File]::Delete($old) } catch { } }
        }
    }
    if (-not ('AgentTaskCenter.ScreenControl.Native' -as [type])) {
        [void][Reflection.Assembly]::LoadFrom($dll)
    }
}

# ---------------------------------------------------------------------------------------------
# State: state.json (shared with the overlay and the desktop app), the overlay process
# ---------------------------------------------------------------------------------------------

function Set-Paths {
    $script:StatePath = [IO.Path]::Combine($StateDir, 'state.json')
    $script:AckPath = [IO.Path]::Combine($StateDir, 'cursor_ack.json')
    $script:PidPath = [IO.Path]::Combine($StateDir, 'overlay.pid')
    $script:ReadyPath = [IO.Path]::Combine($StateDir, 'overlay.ready')
    $script:OverlayLog = [IO.Path]::Combine($StateDir, 'overlay.log')
    $script:ObsPath = [IO.Path]::Combine($StateDir, 'last_observation.json')
    $script:ActionsPath = [IO.Path]::Combine($StateDir, 'actions.jsonl')
    $script:ShotsDir = [IO.Path]::Combine($StateDir, 'shots')
}

function Now-Iso { return [DateTime]::Now.ToString('o') }

function Read-JsonFile([string]$path) {
    $text = $FU::ReadShared($path)
    if (-not $text) { return $null }
    $obj = $MJ::TryParse($text)
    if ($obj -is [System.Collections.IDictionary]) { return $obj }
    return $null
}

function Read-State { return (Read-JsonFile $script:StatePath) }

<#
    Writes state.json atomically. A release, once requested in this session, is never undone by
    a write from a stale copy: only start and stop (-ClearRelease) clear it.
#>
function Write-State($state, [switch]$ClearRelease) {
    if (-not $ClearRelease) {
        $disk = Read-State
        if ($disk -and $disk['release_requested'] -eq $true -and [string]$disk['session'] -eq [string]$state['session']) {
            $state['release_requested'] = $true
            $state['released_at'] = [string]$disk['released_at']
            $state['release_source'] = [string]$disk['release_source']
        }
    }
    [void]$FU::WriteAtomic($script:StatePath, $MJ::Serialize($state, $true))
}

function Remove-Quietly([string[]]$paths) {
    foreach ($p in $paths) { try { if ([IO.File]::Exists($p)) { [IO.File]::Delete($p) } } catch { } }
}

function Agent-Name {
    if (Has 'agent') { return (OptStr 'agent') }
    if ($env:ATC_AGENT_NAME) { return $env:ATC_AGENT_NAME }
    return 'Agent'
}

function New-State([bool]$auto) {
    $position = OptStr 'position' 'TopCenter'
    if (@('TopCenter', 'TopRight', 'BottomCenter', 'BottomRight') -notcontains $position) {
        Quit 2 "-Position must be TopCenter, TopRight, BottomCenter or BottomRight."
    }
    $idle = OptInt 'idleexitminutes' $(if ($auto) { 5 } else { 20 }) 'IdleExitMinutes'
    return [ordered]@{
        active            = $true
        session           = [guid]::NewGuid().ToString('N')
        agent             = (Agent-Name)
        agent_id          = [string]$env:ATC_AGENT_ID
        action            = (OptStr 'action')
        started           = (Now-Iso)
        heartbeat         = (Now-Iso)
        release_requested = $false
        released_at       = ''
        release_source    = ''
        auto_started      = $auto
        idle_exit_minutes = $idle
        color             = (OptStr 'color' '#FF9A1F')
        thickness         = (OptInt 'thickness' 0 'Thickness')
        show_cursor       = (-not $script:Opt['nocursor'])
        show_edges        = (-not $script:Opt['noedges'])
        panel_position    = $position
        cursor_seq        = 0
        cursor_action     = ''
        cursor_x          = 0
        cursor_y          = 0
        cursor_to_x       = 0
        cursor_to_y       = 0
        cursor_button     = 'left'
        cursor_count      = 1
        cursor_scroll_x   = 0
        cursor_scroll_y   = 0
        cursor_window     = ''
        cursor_issued     = ''
    }
}

function Get-OverlayProcess {
    $raw = $FU::ReadShared($script:PidPath)
    if (-not $raw) { return $null }
    $overlayPid = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$overlayPid)) { return $null }
    try { $proc = [Diagnostics.Process]::GetProcessById($overlayPid) } catch { return $null }
    try {
        if ($proc.HasExited -or $proc.ProcessName -notmatch '^powershell') { return $null }
    }
    catch { return $null }
    return $proc
}

<# Launches the hidden overlay process and waits until it reports that it is drawing. #>
function Start-Overlay([int]$idle) {
    if (Get-OverlayProcess) { return $true }
    [void][IO.Directory]::CreateDirectory($StateDir)
    Remove-Quietly @($script:ReadyPath)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $WinPS
    $psi.Arguments = ('-NoProfile -STA -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" overlay -IdleExitMinutes {1} -StateDir "{2}"' -f $PSCommandPath, $idle, $StateDir)
    # Shell execution: the overlay must not inherit this process's stdout, or a caller that
    # reads our output to the end would wait for the overlay to exit.
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $proc = [Diagnostics.Process]::Start($psi)
    [IO.File]::WriteAllText($script:PidPath, [string]$proc.Id)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 20000) {
        if ($proc.HasExited) {
            Remove-Quietly @($script:PidPath)
            return $false
        }
        $ready = $FU::ReadShared($script:ReadyPath)
        if ($ready -and $ready.Trim() -eq [string]$proc.Id) { return $true }
        [Threading.Thread]::Sleep(40)
    }
    return (-not $proc.HasExited)
}

function Stop-Overlay {
    $state = Read-State
    if ($state) {
        $state['active'] = $false
        # The request has been honoured, so it must not colour the next session.
        $state['release_requested'] = $false
        $state['heartbeat'] = Now-Iso
        Write-State $state -ClearRelease
    }
    $proc = Get-OverlayProcess
    if ($proc) {
        if (-not $proc.WaitForExit(4000)) { try { $proc.Kill() } catch { } }
    }
    Remove-Quietly @($script:PidPath, $script:ReadyPath)
}

function Quit-Released($state) {
    $how = ''
    if ($state -and $state['release_source']) { $how += " via $($state['release_source'])" }
    if ($state -and $state['released_at']) { $how += " at $($state['released_at'])" }
    Quit 3 ("The user took back control (release requested$how). Stop driving the screen now, " +
        "do not retry, and tell the user. Run 'start' again only if the user asks you to continue.")
}

function Assert-NotReleased {
    $state = Read-State
    if ($state -and $state['release_requested'] -eq $true) { Quit-Released $state }
}

function Apply-Identity($state) {
    if ($env:ATC_AGENT_ID -and [string]$state['agent_id'] -ne $env:ATC_AGENT_ID) {
        # Another agent is driving now; the desktop app shows whoever issued the last command.
        $state['agent_id'] = $env:ATC_AGENT_ID
        $state['agent'] = (Agent-Name)
    }
}

<# Heartbeat for an active session, so the overlay knows the agent is still at work. #>
function Touch-State([string]$say) {
    $state = Read-State
    if (-not $state -or $state['active'] -ne $true) { return }
    $state['heartbeat'] = Now-Iso
    if ($say) { $state['action'] = $say }
    Apply-Identity $state
    Write-State $state
}

<#
    Input commands need the overlay: start a session automatically (agent name from
    ATC_AGENT_NAME, short idle exit) or refresh the running one, and make sure it is drawing.
#>
function Ensure-Session([string]$say) {
    $state = Read-State
    if ($state -and $state['release_requested'] -eq $true) { Quit-Released $state }
    if (-not $state -or $state['active'] -ne $true) {
        $state = New-State $true
        Remove-Quietly @($script:AckPath, $script:OverlayLog)
        Write-State $state -ClearRelease
    }
    $state['heartbeat'] = Now-Iso
    if (Has 'action') { $state['action'] = OptStr 'action' }
    elseif ($say) { $state['action'] = $say }
    Apply-Identity $state
    Write-State $state
    if (-not (Get-OverlayProcess)) {
        $idle = [int]$state['idle_exit_minutes']
        if ($idle -le 0) { $idle = 5 }
        if (-not (Start-Overlay $idle)) {
            Quit 4 ("The overlay could not be started. Run it in the foreground to see why: " +
                "powershell -NoProfile -STA -File `"$PSCommandPath`" overlay")
        }
    }
    return (Read-State)
}

# ---------------------------------------------------------------------------------------------
# Targets, observations and the policy
# ---------------------------------------------------------------------------------------------

function Set-LogTarget($w) {
    if (-not $w) { return }
    $script:LogWindow = [string]$w.Title
    $script:LogProcess = [string]$w.Process
    $script:LogHwnd = [long]$w.Hwnd
}

function Set-LogTargetHandle([IntPtr]$h) {
    if ($h -eq [IntPtr]::Zero) { return }
    Set-LogTarget ($WO::Info($h))
    $inner = $WO::EffectiveProcess($h)
    if ($inner) { $script:LogProcess = $inner }
}

function Assert-Allowed([IntPtr]$root) {
    $reason = $PO::CheckWindow($root)
    if ($reason) { Quit 4 "Refused: $reason" }
}

function Resolve-Window([string]$spec, [bool]$allowMinimized) {
    $w = $WO::Resolve($spec, $allowMinimized)
    if (-not $w) {
        Quit 4 "No open window matches '$spec'. Run apps or windows to see what is open."
    }
    return $w
}

function Load-Observation {
    $obs = Read-JsonFile $script:ObsPath
    if (-not $obs) { Quit 2 'There is no observation yet: run state -Window <window> first.' }
    return $obs
}

<# The observed window, if it still exists and is still the same window. #>
function Get-ObservedWindow($obs) {
    $w = $obs['window']
    $h = [IntPtr][long]$w['hwnd']
    if (-not $NA::IsWindow($h) -or [long]$WO::Pid($h) -ne [long]$w['pid']) {
        Quit 4 "The observed window '$($w['title'])' is gone. Run apps or windows, then state again."
    }
    if ($NA::IsIconic($h)) {
        Quit 4 "The observed window '$($w['title'])' is minimized now. Run activate, then state again."
    }
    return $h
}

<# How far the window moved since the observation; refuses if it changed size. #>
function Get-WindowShift($obs, [IntPtr]$h) {
    $then = $obs['window']['bounds']
    $now = $WO::Bounds($h)
    if ($now.Width -ne [int]$then['width'] -or $now.Height -ne [int]$then['height']) {
        Quit 4 (('The window changed size since the observation ({0}x{1} -> {2}x{3}), so its coordinates ' +
            'are stale. Run state again.') -f $then['width'], $then['height'], $now.Width, $now.Height)
    }
    return @(($now.X - [int]$then['x']), ($now.Y - [int]$then['y']))
}

function Get-ObservedElement($obs, [int]$index) {
    if ($obs['hasTree'] -ne $true) {
        Quit 2 'The last observation has no element tree: run state -Window <window> -Text first.'
    }
    $els = $obs['elements']
    if ($index -lt 0 -or $index -ge $els.Count) {
        Quit 2 "Element $index is not in the last observation, which numbers 0 to $($els.Count - 1)."
    }
    return $els[$index]
}

function Describe-Element($el) {
    $name = [string]$el['name']
    if ($name.Length -gt 40) { $name = $name.Substring(0, 40) + '...' }
    return ('[{0}] {1} "{2}"' -f $el['index'], $el['controlType'], $name)
}

<# Screen pixel at the centre of an observed element, adjusted if the window has moved. #>
function Get-ElementPoint($obs, [int]$index) {
    $h = Get-ObservedWindow $obs
    $el = Get-ObservedElement $obs $index
    $r = $el['rect']
    if ([int]$r['width'] -le 0 -or [int]$r['height'] -le 0) {
        Quit 4 ("$(Describe-Element $el) has no on-screen rectangle (it may be virtualized or hidden). " +
            'Try invoke, or scroll it into view and observe again.')
    }
    if ($el['offscreen'] -eq $true) {
        Quit 4 "$(Describe-Element $el) is scrolled out of view. Scroll it into view (invoke -Pattern ScrollIntoView) and observe again."
    }
    $shift = Get-WindowShift $obs $h
    $x = [int][Math]::Floor([int]$r['x'] + [int]$r['width'] / 2) + $shift[0]
    $y = [int][Math]::Floor([int]$r['y'] + [int]$r['height'] / 2) + $shift[1]
    $bounds = $WO::Bounds($h)
    if (-not $bounds.Contains($x, $y) -or -not $ST::OnSomeScreen($x, $y)) {
        Quit 4 "$(Describe-Element $el) is outside the visible window ($x,$y). Scroll it into view and observe again."
    }
    return @($x, $y, $h, $el)
}

<# Screen pixel for a pixel in the last observation's image. #>
function Get-ImagePoint($obs, [int]$px, [int]$py) {
    $img = $obs['image']
    if (-not $img) { Quit 2 'The last observation has no screenshot: run state without -NoShot.' }
    if ($px -lt 0 -or $py -lt 0 -or $px -ge [int]$img['width'] -or $py -ge [int]$img['height']) {
        Quit 2 "($px,$py) is outside the $($img['width'])x$($img['height']) image of the last observation."
    }
    $h = Get-ObservedWindow $obs
    $shift = Get-WindowShift $obs $h
    $zoom = [double]$img['zoom']
    if ($zoom -le 0) { $zoom = 1.0 }
    $x = [int][Math]::Round([double]$img['originX'] + ($px + 0.5) / $zoom - 0.5) + $shift[0]
    $y = [int][Math]::Round([double]$img['originY'] + ($py + 0.5) / $zoom - 0.5) + $shift[1]
    return @($x, $y, $h)
}

# ---------------------------------------------------------------------------------------------
# The action log the desktop app displays
# ---------------------------------------------------------------------------------------------

function Write-ActionLog {
    try {
        $state = Read-State
        $agent = if ($state -and $state['active'] -eq $true -and $state['agent']) { [string]$state['agent'] } else { Agent-Name }
        $record = [ordered]@{
            timestamp   = (Now-Iso)
            agent       = $agent
            agent_id    = [string]$env:ATC_AGENT_ID
            session     = $(if ($state) { [string]$state['session'] } else { '' })
            command     = [string]$script:Command
            args        = [string]$script:LogArgs
            window      = [string]$script:LogWindow
            process     = [string]$script:LogProcess
            hwnd        = [long]$script:LogHwnd
            code        = [int]$script:Code
            message     = [string]$script:Message
            duration_ms = [long]$script:Started.ElapsedMilliseconds
        }
        [void]$FU::AppendLine($script:ActionsPath, $MJ::Serialize($record, $false))
        $FU::TrimLines($script:ActionsPath, 150000, 1000, 500)
    }
    catch { }
}

# ---------------------------------------------------------------------------------------------
# Pointer commands: the overlay glides the agent's pointer, then borrows the real one
# ---------------------------------------------------------------------------------------------

<#
    Hands one pointer command to the overlay and waits for its answer.
    Returns @{ code; message; window; process; hwnd }: 0 done, 3 released, 4 refused or failed.
#>
function Invoke-Pointer($state, [string]$kind, [int]$px, [int]$py, [int]$qx, [int]$qy,
    [string]$button, [int]$count, [int]$sx, [int]$sy, [string]$guard, [switch]$Retried) {
    $seq = 1 + [int]$state['cursor_seq']
    $state['cursor_seq'] = $seq
    $state['cursor_action'] = $kind
    $state['cursor_x'] = $px
    $state['cursor_y'] = $py
    $state['cursor_to_x'] = $qx
    $state['cursor_to_y'] = $qy
    $state['cursor_button'] = $button
    $state['cursor_count'] = $count
    $state['cursor_scroll_x'] = $sx
    $state['cursor_scroll_y'] = $sy
    $state['cursor_window'] = $guard
    $state['cursor_issued'] = Now-Iso
    $state['heartbeat'] = Now-Iso
    Write-State $state

    $timeout = OptInt 'timeoutseconds' 15 'TimeoutSeconds'
    $overlay = Get-OverlayProcess
    $overlayPid = if ($overlay) { $overlay.Id } else { 0 }
    $raw = $CT::WaitForAck($script:AckPath, $seq, 1000 * [Math]::Max(1, $timeout), $overlayPid)
    if ($raw -eq '' -and -not $Retried) {
        # The overlay exited (an idle exit, say) just as the command arrived: start a fresh one
        # and send the command once more.
        $fresh = Read-State
        if ($fresh -and $fresh['active'] -eq $true -and $fresh['release_requested'] -ne $true) {
            $idle = [int]$fresh['idle_exit_minutes']
            if ($idle -le 0) { $idle = 5 }
            if (Start-Overlay $idle) {
                return (Invoke-Pointer (Read-State) $kind $px $py $qx $qy $button $count $sx $sy $guard -Retried)
            }
        }
    }
    if ($raw -eq '') {
        return @{ code = 4; message = "The overlay stopped before answering the $kind. Observe before trying again." }
    }
    if (-not $raw) {
        return @{ code = 4; message = ("The overlay did not confirm the $kind within $timeout seconds. It may " +
                'still have happened, so observe before trying again; overlay.log in the state directory shows how far it got.') }
    }
    $ack = $MJ::TryParse($raw)
    $r = @{ code = 4; message = [string]$ack['message']; window = [string]$ack['window']
        process = [string]$ack['process']; hwnd = [long]$ack['hwnd'] }
    if ($ack['ok'] -eq $true) { $r.code = 0 }
    elseif ($ack['released'] -eq $true) { $r.code = 3 }
    return $r
}

function Invoke-PointerCommand([string]$kind) {
    $guard = OptStr 'window'
    $observed = [IntPtr]::Zero
    $x = 0; $y = 0; $qx = 0; $qy = 0
    $where = ''

    if (Has 'element') {
        if ($kind -eq 'drag') { Quit 2 'drag takes coordinates (-X -Y -ToX -ToY, optionally with -Image), not -Element.' }
        $obs = Load-Observation
        $p = Get-ElementPoint $obs (OptInt 'element' 0 'Element')
        $x = $p[0]; $y = $p[1]; $observed = $p[2]
        $where = Describe-Element $p[3]
    }
    elseif ($script:Opt['image']) {
        $obs = Load-Observation
        $p = Get-ImagePoint $obs (Need-Int 'x' 'X') (Need-Int 'y' 'Y')
        $x = $p[0]; $y = $p[1]; $observed = $p[2]
        if ($kind -eq 'drag') {
            $q = Get-ImagePoint $obs (Need-Int 'tox' 'ToX') (Need-Int 'toy' 'ToY')
            $qx = $q[0]; $qy = $q[1]
        }
    }
    else {
        $x = Need-Int 'x' 'X'
        $y = Need-Int 'y' 'Y'
        if ($kind -eq 'drag') { $qx = Need-Int 'tox' 'ToX'; $qy = Need-Int 'toy' 'ToY' }
    }
    # Coordinates from an observation belong to that window: refuse if something else is on top.
    if (-not $guard -and $observed -ne [IntPtr]::Zero) { $guard = [string]$observed.ToInt64() }

    $button = (OptStr 'button' 'Left').ToLowerInvariant()
    $count = OptInt 'count' 1 'Count'
    if ($button -eq 'double') { $button = 'left'; $count = 2 }
    if (@('left', 'right', 'middle') -notcontains $button) { Quit 2 '-Button must be Left, Right, Middle or Double.' }
    if ($count -lt 1 -or $count -gt 3) { Quit 2 '-Count must be 1, 2 or 3.' }
    $sx = 0; $sy = 0
    if ($kind -eq 'scroll') {
        $sx = OptInt 'scrollx' 0 'ScrollX'
        $sy = OptInt 'scrolly' 0 'ScrollY'
        if ($sx -eq 0 -and $sy -eq 0) { Quit 2 'scroll needs -ScrollY and/or -ScrollX, in wheel notches (positive = down / right).' }
        if ([Math]::Abs($sx) -gt 50 -or [Math]::Abs($sy) -gt 50) { Quit 2 'Scroll at most 50 notches at a time, then observe.' }
    }
    $script:LogArgs = switch ($kind) {
        'click' { "x=$x y=$y button=$button count=$count" + $(if ($where) { " element=$where" } else { '' }) }
        'drag' { "x=$x y=$y to_x=$qx to_y=$qy" }
        'scroll' { "x=$x y=$y scroll_x=$sx scroll_y=$sy" }
        default { "x=$x y=$y" }
    }

    # Refuse early, before anything moves: the named window, then what is under the point.
    $root = $WO::RootAt($x, $y)
    Set-LogTargetHandle $root
    if ($guard) {
        $named = $WO::Resolve($guard, $true)
        if ($named -and $kind -ne 'move') { Assert-Allowed $named.Handle }
        if (-not $WO::Matches($guard, $root)) {
            Quit 4 "The point ($x,$y) is in '$($WO::Describe($root))', not '$guard', so nothing was done. Observe again."
        }
    }
    if ($kind -ne 'move') {
        Assert-Allowed $root
        if ($kind -eq 'drag') {
            $end = $WO::RootAt($qx, $qy)
            Assert-Allowed $end
            if ($guard -and -not $WO::Matches($guard, $end)) {
                Quit 4 "The drag would end in '$($WO::Describe($end))', not '$guard', so nothing was done."
            }
        }
    }

    $target = $WO::Describe($root)
    $say = switch ($kind) {
        'click' { $(if ($button -ne 'left') { "$(([string]$button).Substring(0,1).ToUpper() + $button.Substring(1))-clicking" } elseif ($count -gt 1) { 'Double-clicking' } else { 'Clicking' }) + $(if ($where) { " $where" } else { '' }) + " in $target" }
        'drag' { "Dragging in $target" }
        'scroll' { "Scrolling in $target" }
        default { 'Moving the pointer' }
    }
    $state = Ensure-Session $say
    $r = Invoke-Pointer $state $kind $x $y $qx $qy $button $count $sx $sy $guard
    if ($r.window) { $script:LogWindow = $r.window }
    if ($r.process) { $script:LogProcess = $r.process }
    if ($r.hwnd) { $script:LogHwnd = $r.hwnd }
    if ($r.code -eq 3) { Quit-Released (Read-State) }
    if ($r.code -ne 0) { Quit $r.code $r.message }
    $in = if ($r.window) { " in $($r.window)" } else { '' }
    $what = switch ($kind) {
        'click' { "$button click" + $(if ($count -gt 1) { " x$count" } else { '' }) + " at $x,$y" }
        'drag' { "drag $x,$y -> $qx,$qy" }
        'scroll' { "scroll x=$sx y=$sy notches at $x,$y" }
        default { "move to $x,$y" }
    }
    Quit 0 ($what + $in)
}

# ---------------------------------------------------------------------------------------------
# Keyboard commands
# ---------------------------------------------------------------------------------------------

<# The window that will receive keys: -Window (activated), or else the foreground window. #>
function Resolve-KeyTarget([string]$say) {
    $spec = OptStr 'window'
    if ($spec) {
        $w = Resolve-Window $spec $true
        Set-LogTarget $w
        Assert-Allowed $w.Handle
        [void](Ensure-Session $say)
        $how = ''
        if (-not $WO::Activate($w.Handle, [ref]$how)) {
            Quit 4 "Could not bring '$($w.Title)' to the foreground ($how), so no keys were sent."
        }
        return $w.Handle
    }
    $fg = $NA::GetForegroundWindow()
    if ($fg -eq [IntPtr]::Zero) { Quit 4 'No window has the keyboard focus. Pass -Window.' }
    $root = $NA::GetAncestor($fg, 2)
    Set-LogTargetHandle $root
    $reason = $PO::CheckWindow($root)
    if ($reason) {
        Quit 4 ("Refused: $reason Without -Window, keys go to the foreground window " +
            "('$($WO::Describe($root))'); pass -Window to name the app you mean.")
    }
    [void](Ensure-Session $say)
    return $root
}

function Assert-StillTarget([IntPtr]$target) {
    if ($CT::ReleaseRequested($script:StatePath)) { Quit-Released (Read-State) }
    if (-not $WO::IsForeground($target)) {
        Quit 4 "The foreground window changed to '$($WO::Describe($NA::GetForegroundWindow()))', so input stopped. Observe again."
    }
}

# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------

$HelpText = @'
computer-use: see and drive Windows desktop apps.  Usage: computer.ps1 <command> [options]

Look (no overlay needed)
  apps       [-App text] [-Json]              running apps with visible windows (process, path, pid, windows)
  windows    [-Window text] [-Json]           visible windows front to back, with hwnd and bounds
  state      -Window t|hwnd [-Text] [-NoShot] [-Out png] [-Zoom n] [-MaxElements n] [-Json]
                                              screenshot of one window (+ numbered UI Automation tree with -Text)
  screenshot [-Window t|hwnd | -X -Y -Width -Height] [-Out png] [-Zoom n]
  status     [-Json]   policy [-Json]   help

Act (the overlay starts automatically; every command checks the app policy first)
  launch     -App name|path|AppUserModelId [-TimeoutSeconds n]
  activate   -Window t|hwnd
  click      -Element n | -X -Y [-Image] [-Button Left|Right|Middle|Double] [-Count n] [-Window t|hwnd]
  move       -X -Y [-Image]
  drag       -X -Y -ToX -ToY [-Image] [-Window t|hwnd]
  scroll     -Element n | -X -Y [-Image] [-ScrollY n] [-ScrollX n]      (notches; + = down/right)
  type       -Text s | -TextFile path [-Window t|hwnd]                  (newlines press Enter)
  key        -Keys chord [-Window t|hwnd] [-Repeat n]                  (e.g. Control_L+s, Return, KP_0)
  set-value  -Element n -Value s
  invoke     -Element n [-Pattern Invoke|Toggle|Expand|Collapse|Select|Focus|ScrollIntoView]

Session
  start [-Agent name] [-Action text] [-Position TopCenter|TopRight|BottomCenter|BottomRight]
  action -Action text     stop     release     demo

Coordinates: -X/-Y are real screen pixels; with -Image they are pixels of the last `state`
image; -Element n is element n of the last `state -Text`. Re-observe after every action.
Exit codes: 0 done, 2 bad arguments, 3 user took back control (stop now), 4 refused/failed.
'@

function Command-Apps {
    $list = $ST::Apps((OptStr 'app'))
    if ($script:Opt['json']) {
        $parts = @(); foreach ($a in $list) { $parts += $a.ToJson() }
        Say ('[' + ($parts -join ",`n") + ']')
        return
    }
    if ($list.Count -eq 0) { Quit 4 'No app with a visible window matches.' }
    foreach ($a in $list) {
        Say ('{0}  pid={1}  {2}' -f $a.Process, $a.Pid, $a.Path)
        foreach ($w in $a.Windows) {
            $where = if ($w.Minimized) { 'minimized' } else { 'x={0} y={1} width={2} height={3}' -f $w.Bounds.X, $w.Bounds.Y, $w.Bounds.Width, $w.Bounds.Height }
            Say ('    hwnd={0}  {1}  "{2}"' -f $w.Hwnd, $where, $w.Title)
        }
    }
}

function Command-Windows {
    $spec = OptStr 'window'
    $found = $ST::Windows($spec)
    if ($script:Opt['json']) {
        $parts = @(); foreach ($w in $found) { $parts += $w.ToJson() }
        Say ('[' + ($parts -join ",`n") + ']')
        if ($found.Count -eq 0 -and $spec) { $script:Code = 4 }
        return
    }
    if ($found.Count -eq 0) { Quit 4 "No visible window matches '$spec'." }
    foreach ($w in $found) { Say $w.ToString() }
}

function Command-State {
    $spec = OptStr 'window'
    if (-not $spec) { Quit 2 'state needs -Window <title text or hwnd>. Run apps or windows to find one.' }
    $w = Resolve-Window $spec $true
    Set-LogTarget $w
    Assert-Allowed $w.Handle
    $noShot = [bool]$script:Opt['noshot']
    $tree = [bool]$script:Opt['text']
    if ($noShot -and -not $tree) { Quit 2 '-NoShot leaves nothing to observe; add -Text.' }
    if ($w.Minimized -and -not $noShot) {
        Quit 4 "'$($w.Title)' is minimized, so there is nothing to capture. Run activate -Window $($w.Hwnd) first."
    }
    $out = $null
    if (-not $noShot) {
        $out = OptStr 'out'
        if (-not $out) {
            $out = [IO.Path]::Combine($script:ShotsDir, 'state-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff') + '.png')
        }
        $out = [IO.Path]::GetFullPath($out)
    }
    $zoom = OptDouble 'zoom' 0 'Zoom'
    if ($zoom -lt 0 -or $zoom -gt 4) { Quit 2 '-Zoom must be between 0.05 and 4 (omit it to fit the image to what vision models read).' }
    $max = OptInt 'maxelements' 400 'MaxElements'
    $timeout = OptInt 'timeoutseconds' 20 'TimeoutSeconds'
    $script:LogArgs = "text=$tree shot=$(-not $noShot)"
    $obs = $OB::Take($w.Handle, $out, $tree, $zoom, [Math]::Max(1, $max), 1000 * [Math]::Max(1, $timeout))
    [void]$FU::WriteAtomic($script:ObsPath, $obs.ToJson())
    $FU::Prune($script:ShotsDir, 'state-*.png', 30)
    Touch-State ''
    if ($script:Opt['json']) { Say $obs.ToJson() } else { [Console]::Out.Write($obs.ToText()) }
}

function Command-Screenshot {
    $out = OptStr 'out'
    if (-not $out) {
        $out = [IO.Path]::Combine($script:ShotsDir, 'screenshot-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff') + '.png')
    }
    $path = [IO.Path]::GetFullPath($out)
    $zoom = OptDouble 'zoom' 1.0 'Zoom'
    if ($zoom -le 0 -or $zoom -gt 4) { Quit 2 '-Zoom must be between 0.05 and 4.' }
    $spec = OptStr 'window'
    if ($spec) {
        $w = Resolve-Window $spec $false
        Set-LogTarget $w
        Assert-Allowed $w.Handle
        $method = ''
        $bmp = $ST::GrabWindow($w.Handle, $w.Bounds, [ref]$method)
        try { $size = $ST::SavePng($bmp, $path, $zoom) } finally { $bmp.Dispose() }
        Say ('saved {0}  origin x={1} y={2}  size {3}x{4}  zoom {5}  (image {6}x{7}, capture: {8})' -f
            $path, $w.Bounds.X, $w.Bounds.Y, $w.Bounds.Width, $w.Bounds.Height, $zoom, $size.Width, $size.Height, $method)
    }
    elseif ((Has 'width') -or (Has 'height')) {
        $rw = Need-Int 'width' 'Width'; $rh = Need-Int 'height' 'Height'
        $rx = Need-Int 'x' 'X'; $ry = Need-Int 'y' 'Y'
        if ($rw -le 0 -or $rh -le 0) { Quit 2 '-Width and -Height must be positive.' }
        Say ($ST::Capture($path, $rx, $ry, $rw, $rh, $zoom))
    }
    else {
        Say ($ST::Capture($path, 0, 0, 0, 0, $zoom))
    }
    $FU::Prune($script:ShotsDir, 'screenshot-*.png', 30)
    Touch-State ''
}

function Command-Launch {
    $app = OptStr 'app'
    if (-not $app) { Quit 2 'launch needs -App <name, .exe path, or AppUserModelId>.' }
    $script:LogArgs = "app=$app"
    $isAumid = $app.Contains('!')
    $expected = ''
    if (-not $isAumid) { $expected = $PO::Normalize([IO.Path]::GetFileName($app)) }
    # Refuse by name before anything starts.
    foreach ($name in @($expected, $app)) {
        if (-not $name) { continue }
        foreach ($denied in $PO::BuiltInDenied) {
            if ($PO::Normalize([IO.Path]::GetFileName($name)) -ieq $denied -or ($isAumid -and $name -like "*$denied*")) {
                Quit 4 "Refused: '$denied' is on the built-in deny list, so computer use will not launch it."
            }
        }
    }
    if ($expected) { $reason = $PO::CheckProcess($expected); if ($reason) { Quit 4 "Refused: $reason" } }

    $before = @{}
    foreach ($w in $ST::Windows('')) { $before[[string]$w.Hwnd] = $true }
    $proc = $null
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.UseShellExecute = $true
    if ($isAumid) {
        $psi.FileName = 'explorer.exe'
        $psi.Arguments = "shell:AppsFolder\$app"
    }
    else { $psi.FileName = $app }
    try { $proc = [Diagnostics.Process]::Start($psi) }
    catch {
        # Not a path or registered name: try the Start menu's app list.
        $start = $null
        try { $start = @(Get-StartApps | Where-Object { $_.Name -ieq $app }) } catch { }
        if (-not $start -or $start.Count -eq 0) { try { $start = @(Get-StartApps | Where-Object { $_.Name -like "*$app*" }) } catch { } }
        if (-not $start -or $start.Count -ne 1) {
            $more = if ($start.Count -gt 1) { " Several Start menu apps match: $(($start | ForEach-Object { $_.Name }) -join ', ')." } else { '' }
            Quit 4 ("Could not launch '$app': $($_.Exception.Message)" + $more)
        }
        foreach ($denied in $PO::BuiltInDenied) {
            if ($start[0].AppID -like "*$denied*" -or $start[0].Name -ieq $denied) { Quit 4 "Refused: '$($start[0].Name)' is on the built-in deny list." }
        }
        $psi.FileName = 'explorer.exe'
        $psi.Arguments = "shell:AppsFolder\$($start[0].AppID)"
        $isAumid = $true
        $proc = [Diagnostics.Process]::Start($psi)
    }
    $launchedPid = if ($proc) { try { $proc.Id } catch { 0 } } else { 0 }

    $timeout = OptInt 'timeoutseconds' 15 'TimeoutSeconds'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $found = $null
    while ($sw.ElapsedMilliseconds -lt 1000 * $timeout -and -not $found) {
        [Threading.Thread]::Sleep(250)
        $fresh = @($ST::Windows('') | Where-Object { -not $before.ContainsKey([string]$_.Hwnd) })
        $found = @($fresh | Where-Object { $launchedPid -and $_.Pid -eq $launchedPid })[0]
        if (-not $found -and $expected) { $found = @($fresh | Where-Object { $_.Process -ieq $expected })[0] }
        if (-not $found -and ($isAumid -or -not $expected) -and $sw.ElapsedMilliseconds -gt 1500) {
            # A Store app or an unknown launcher: the first new window that is not a bare Explorer folder.
            $found = @($fresh | Where-Object { $_.Process -ne 'explorer' -or $_.ClassName -ne 'CabinetWClass' })[0]
        }
    }
    if (-not $found -and $expected) {
        # A single-instance app may just have brought its existing window forward.
        $existing = @($ST::Windows('') | Where-Object { $_.Process -ieq $expected })
        if ($existing.Count -gt 0) {
            Set-LogTarget $existing[0]
            Quit 0 ("launched; no new window appeared, but $expected already has one:`n" + $existing[0].ToString())
        }
    }
    if (-not $found) { Quit 4 "Launched '$app', but no new window appeared within $timeout seconds. Run apps to check." }
    Set-LogTarget $found
    $reason = $PO::CheckWindow($found.Handle)
    if ($reason) { Quit 4 "Launched, but the new window is refused: $reason Do not drive it." }
    Touch-State ''
    Quit 0 ("launched: " + $found.ToString())
}

function Command-Activate {
    $spec = OptStr 'window'
    if (-not $spec) { Quit 2 'activate needs -Window <title text or hwnd>.' }
    $w = Resolve-Window $spec $true
    Set-LogTarget $w
    Assert-Allowed $w.Handle
    Touch-State "Bringing $($w.Title) to the front"
    $how = ''
    if (-not $WO::Activate($w.Handle, [ref]$how)) { Quit 4 "Could not bring '$($w.Title)' to the foreground: $how." }
    $now = $WO::Info($w.Handle)
    Quit 0 ("activated ($how): " + $now.ToString())
}

function Command-Type {
    $text = $null
    if (Has 'textfile') {
        $file = OptStr 'textfile'
        if (-not [IO.File]::Exists($file)) { Quit 2 "-TextFile '$file' does not exist." }
        $text = [IO.File]::ReadAllText([IO.Path]::GetFullPath($file), [Text.Encoding]::UTF8)
    }
    elseif (Has 'text') { $text = [string]$script:Opt['text'] }
    if ($null -eq $text -or $text.Length -eq 0) { Quit 2 "type needs -Text <text> (or -TextFile <path>)." }
    $script:LogArgs = "length=$($text.Length)"
    $delay = OptInt 'delayms' 8 'DelayMs'
    $target = Resolve-KeyTarget "Typing $($text.Length) characters"
    Assert-StillTarget $target
    $statePath = $script:StatePath
    $wo = $WO; $ct = $CT
    $check = [Func[string]] {
        if ($ct::ReleaseRequested($statePath)) { return 'released' }
        if (-not $wo::IsForeground($target)) { return 'focus' }
        return $null
    }.GetNewClosure()
    $typed = 0
    $stop = $KB::Type($text, [Math]::Max(0, $delay), 16, $check, [ref]$typed)
    if ($stop -eq 'released') { Quit-Released (Read-State) }
    if ($stop -eq 'focus') {
        Quit 4 "The foreground window changed after $typed of $($text.Length) characters, so typing stopped. Observe before continuing."
    }
    if ($stop) { Quit 4 "$stop ($typed of $($text.Length) characters were typed)" }
    Quit 0 "typed $typed characters into $($WO::Describe($target))"
}

function Command-Key {
    $keys = OptStr 'keys'
    if (-not $keys) { Quit 2 'key needs -Keys <chord>, e.g. Return, Control_L+s, Alt+F4, KP_5.' }
    $repeat = OptInt 'repeat' 1 'Repeat'
    if ($repeat -lt 1 -or $repeat -gt 100) { Quit 2 '-Repeat must be between 1 and 100.' }
    $script:LogArgs = "keys=$keys repeat=$repeat"
    $chord = $KB::Parse($keys, $CT::LayoutFor([IntPtr]::Zero))
    if ($chord.Refusal) { Quit 4 "Refused: $($chord.Refusal)" }
    if ($chord.Error) { Quit 2 $chord.Error }
    $target = Resolve-KeyTarget "Pressing $($chord.Display)"
    $chord = $KB::Parse($keys, $CT::LayoutFor($target))
    if ($chord.Refusal) { Quit 4 "Refused: $($chord.Refusal)" }
    if ($chord.Error) { Quit 2 $chord.Error }
    for ($n = 0; $n -lt $repeat; $n++) {
        if ($n -gt 0) { [Threading.Thread]::Sleep(35) }
        Assert-StillTarget $target
        if (-not $KB::Press($chord)) { Quit 4 'Windows refused the keyboard input (an elevated window cannot receive it).' }
    }
    $times = if ($repeat -gt 1) { " x$repeat" } else { '' }
    Quit 0 "pressed $($chord.Display)$times in $($WO::Describe($target))"
}

function Command-ElementAction([string]$action) {
    if (-not (Has 'element')) { Quit 2 "$script:Command needs -Element <index from state -Text>." }
    $index = OptInt 'element' 0 'Element'
    $obs = Load-Observation
    $el = Get-ObservedElement $obs $index
    $h = Get-ObservedWindow $obs
    Set-LogTargetHandle $h
    Assert-Allowed $h
    $value = $null
    if ($action -eq 'set-value') {
        if (-not (Has 'value')) { Quit 2 'set-value needs -Value <text>.' }
        $value = OptStr 'value'
        $script:LogArgs = "element=$(Describe-Element $el) length=$($value.Length)"
        $say = "Setting the value of $(Describe-Element $el)"
    }
    else {
        $script:LogArgs = "element=$(Describe-Element $el) pattern=$action"
        $say = "$($action.Substring(0,1).ToUpper() + $action.Substring(1)): $(Describe-Element $el)"
    }
    [void](Ensure-Session $say)
    $result = ''
    $timeout = OptInt 'timeoutseconds' 10 'TimeoutSeconds'
    $err = $UI::Act($h, [string]$el['runtimeId'], $action, $value, 1000 * [Math]::Max(1, $timeout), [ref]$result)
    if ($err) { Quit 4 "$(Describe-Element $el): $err" }
    Quit 0 "$(Describe-Element $el): $result"
}

function Command-Status {
    $script:LogThis = $false
    $state = Read-State
    $proc = Get-OverlayProcess
    $ack = Read-JsonFile $script:AckPath
    $last = ''
    if ($ack -and $state) {
        $last = if ($ack['ok'] -eq $true) { "done: $($state['cursor_action']) in $($ack['window'])" } else { "failed: $($ack['message'])" }
    }
    $info = [ordered]@{
        active            = [bool]($state -and $state['active'] -eq $true)
        agent             = $(if ($state) { [string]$state['agent'] } else { '' })
        agent_id          = $(if ($state) { [string]$state['agent_id'] } else { '' })
        action            = $(if ($state) { [string]$state['action'] } else { '' })
        session           = $(if ($state) { [string]$state['session'] } else { '' })
        started           = $(if ($state) { [string]$state['started'] } else { '' })
        heartbeat         = $(if ($state) { [string]$state['heartbeat'] } else { '' })
        release_requested = [bool]($state -and $state['release_requested'] -eq $true)
        released_at       = $(if ($state) { [string]$state['released_at'] } else { '' })
        release_source    = $(if ($state) { [string]$state['release_source'] } else { '' })
        auto_started      = [bool]($state -and $state['auto_started'] -eq $true)
        overlay_running   = [bool]$proc
        overlay_pid       = $(if ($proc) { [int]$proc.Id } else { 0 })
        last_pointer      = $last
        state_dir         = $StateDir
    }
    if ($script:Opt['json']) { Say ($MJ::Serialize($info, $true)) }
    else { foreach ($k in $info.Keys) { Say ('{0,-18} {1}' -f ($k + ':'), $info[$k]) } }
    if ($info.release_requested) { $script:Code = 3 }
}

function Command-Policy {
    $script:LogThis = $false
    if ($script:Opt['json']) { Say ($PO::ToJson()); return }
    Say ("config:          " + $PO::ConfigPath + $(if ([IO.File]::Exists($PO::ConfigPath)) { '' } else { ' (not present)' }))
    Say ("built-in denied: " + ($PO::BuiltInDenied -join ', '))
    $allowed = $PO::Allowed; $denied = $PO::Denied
    Say ("allowed:         " + $(if ($allowed.Count) { $allowed -join ', ' } else { '(any app not denied)' }))
    Say ("denied:          " + $(if ($denied.Count) { $denied -join ', ' } else { '(none)' }))
}

function Command-Demo {
    $b = $ST::PrimaryBounds()
    $state = New-State $false
    $state['action'] = 'Demo: the agent pointer moves and taps, but nothing is clicked'
    Remove-Quietly @($script:AckPath, $script:OverlayLog)
    Write-State $state -ClearRelease
    if (-not (Start-Overlay 20)) { Quit 4 'The overlay could not be started.' }
    $stops = @(
        @(0.30, 0.35, 'point', 'Tapping a spot on the left'),
        @(0.72, 0.28, 'point', 'Crossing to the right'),
        @(0.66, 0.72, 'point', 'Down to the lower right'),
        @(0.24, 0.66, 'move', 'Moving without a tap, then resting'),
        @(0.50, 0.50, 'point', 'Back to the middle')
    )
    try {
        [Threading.Thread]::Sleep(1200)
        foreach ($s in $stops) {
            $px = [int]($b.Left + $b.Width * $s[0])
            $py = [int]($b.Top + $b.Height * $s[1])
            $state = Read-State
            $state['action'] = 'Demo: ' + $s[3]
            $r = Invoke-Pointer $state $s[2] $px $py 0 0 'left' 1 0 0 ''
            if ($r.code -ne 0) { [Console]::Error.WriteLine('computer-use: ' + $r.message); break }
            Say ('{0} {1},{2}' -f $s[2], $px, $py)
            [Threading.Thread]::Sleep(2000)
        }
    }
    finally { Stop-Overlay }
    Say 'computer use: demo finished'
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

try {
    Parse-Arguments $args
    if ($script:Opt['statedir']) { $StateDir = OptStr 'statedir' }
    Set-Paths
    if ($script:Command -eq 'help' -or $script:Opt['help']) { $script:LogThis = $false; Say $HelpText; exit 0 }

    Import-ScreenControl
    $NA = [AgentTaskCenter.ScreenControl.Native]
    $WO = [AgentTaskCenter.ScreenControl.WindowOps]
    $ST = [AgentTaskCenter.ScreenControl.ScreenTools]
    $PO = [AgentTaskCenter.ScreenControl.Policy]
    $FU = [AgentTaskCenter.ScreenControl.FileUtil]
    $MJ = [AgentTaskCenter.ScreenControl.MiniJson]
    $CT = [AgentTaskCenter.ScreenControl.CliTools]
    $KB = [AgentTaskCenter.ScreenControl.Keyboard]
    $UI = [AgentTaskCenter.ScreenControl.Uia]
    $OB = [AgentTaskCenter.ScreenControl.Observation]
    $CS = [AgentTaskCenter.ScreenControl.ControlState]
    $NA::UseRealPixels()
    $PO::Configure($StateDir)

    if ($script:Command -eq 'overlay') {
        $script:LogThis = $false
        [AgentTaskCenter.ScreenControl.Overlay]::Run($script:StatePath, (OptInt 'idleexitminutes' 20 'IdleExitMinutes'))
        exit 0
    }

    # Once the person has taken control back, every command but these exits 3.
    if (@('start', 'stop', 'release', 'status', 'policy', 'demo') -notcontains $script:Command) { Assert-NotReleased }

    switch ($script:Command) {
        'apps' { Command-Apps }
        'windows' { Command-Windows }
        'state' { Command-State }
        'screenshot' { Command-Screenshot }
        'launch' { Command-Launch }
        'activate' { Command-Activate }
        'move' { Invoke-PointerCommand 'move' }
        'click' { Invoke-PointerCommand 'click' }
        'drag' { Invoke-PointerCommand 'drag' }
        'scroll' { Invoke-PointerCommand 'scroll' }
        'type' { Command-Type }
        'key' { Command-Key }
        'set-value' { Command-ElementAction 'set-value' }
        'invoke' {
            $pattern = (OptStr 'pattern' 'Invoke').ToLowerInvariant()
            if (@('invoke', 'toggle', 'expand', 'collapse', 'select', 'focus', 'scrollintoview') -notcontains $pattern) {
                Quit 2 '-Pattern must be Invoke, Toggle, Expand, Collapse, Select, Focus or ScrollIntoView.'
            }
            Command-ElementAction $pattern
        }
        'status' { Command-Status }
        'policy' { Command-Policy }
        'demo' { Command-Demo }
        'start' {
            $state = New-State $false
            Remove-Quietly @($script:AckPath, $script:OverlayLog)
            Write-State $state -ClearRelease
            if (-not (Start-Overlay ([int]$state['idle_exit_minutes']))) {
                Quit 4 ("The overlay could not be started. Run it in the foreground to see why: " +
                    "powershell -NoProfile -STA -File `"$PSCommandPath`" overlay")
            }
            Say "computer use: on ($($state['agent']))"
        }
        'action' {
            $state = Read-State
            if (-not $state -or $state['active'] -ne $true) { Quit 2 "Not started. Run 'start' first (input commands start it automatically)." }
            $state['action'] = OptStr 'action'
            $state['heartbeat'] = Now-Iso
            Apply-Identity $state
            Write-State $state
            if (-not (Get-OverlayProcess)) { [void](Start-Overlay ([int]$state['idle_exit_minutes'])) }
        }
        'release' {
            if (-not $CS::RequestRelease($script:StatePath, 'command')) { Quit 4 "Could not write $($script:StatePath)." }
            Say 'release requested: every computer-use command now exits 3 until stop or start.'
        }
        'stop' {
            Stop-Overlay
            Say 'computer use: off'
        }
    }
    exit $script:Code
}
catch {
    $script:Code = 4
    $script:Message = $_.Exception.Message
    [Console]::Error.WriteLine('computer-use: ' + $_.Exception.Message)
    if ($script:Opt['json']) { Say ('{"ok": false, "code": 4, "message": ' + (JsonText $_.Exception.Message) + '}') }
    exit 4
}
finally {
    if ($script:LogThis -and $script:Command -and ('AgentTaskCenter.ScreenControl.FileUtil' -as [type])) { Write-ActionLog }
    if ($script:SavedEncoding) { try { [Console]::OutputEncoding = $script:SavedEncoding } catch { } }
}
