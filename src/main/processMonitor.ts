import os from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentResources, ExternalAgentProcess } from '../shared/types';
import { run } from './util';

interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  workingSet: number;
  cpu100ns: number;
}

interface AgentProcRow {
  pid: number;
  created: string | null;
  exe: string;
  commandLine: string;
}

// One long-lived PowerShell answers each newline on stdin with a snapshot:
// every process (tab-separated, cheap) plus command lines for the processes
// that might be agents. Spawning PowerShell per poll would cost far more.
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $sb = New-Object System.Text.StringBuilder
  $all = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime
  foreach ($p in $all) {
    [void]$sb.Append(('P' + [char]9 + $p.ProcessId + [char]9 + $p.ParentProcessId + [char]9 + $p.Name + [char]9 + $p.WorkingSetSize + [char]9 + ($p.KernelModeTime + $p.UserModeTime) + [char]10))
  }
  $agents = Get-CimInstance -ClassName Win32_Process -Filter "Name='claude.exe' OR Name='codex.exe' OR Name='node.exe'" -Property ProcessId,CommandLine,CreationDate,ExecutablePath
  foreach ($p in $agents) {
    $cmd = [string]$p.CommandLine -replace '[\\t\\r\\n]', ' '
    $created = ''
    if ($p.CreationDate) { $created = $p.CreationDate.ToUniversalTime().ToString('o') }
    [void]$sb.Append(('A' + [char]9 + $p.ProcessId + [char]9 + $created + [char]9 + $p.ExecutablePath + [char]9 + $cmd + [char]10))
  }
  [void]$sb.Append('END' + [char]10)
  [Console]::Out.Write($sb.ToString())
  [Console]::Out.Flush()
}
`;

const HOSTS: Array<[RegExp, string]> = [
  [/^code(\s-\sinsiders)?\.exe$/i, 'VS Code'],
  [/^cursor\.exe$/i, 'Cursor'],
  [/^windsurf\.exe$/i, 'Windsurf'],
  [/^windowsterminal\.exe$/i, 'Windows Terminal'],
  [/^arco workspace\.exe$/i, 'Arco Workspace'],
  [/^(powershell|pwsh|cmd|bash|wsl)\.exe$/i, 'Terminal'],
  [/^explorer\.exe$/i, 'Desktop']
];

export class ProcessMonitor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private waiter: ((text: string) => void) | null = null;
  private previous = new Map<number, { cpu: number; at: number }>();
  private cores = Math.max(1, os.cpus().length);
  private rows = new Map<number, ProcRow & { cpuPercent: number }>();
  private children = new Map<number, number[]>();
  private agentRows: AgentProcRow[] = [];
  private busy = false;
  lastSnapshotAt = 0;

  private ensureChild() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    // The script travels on the command line so stdin carries nothing but
    // snapshot requests; PowerShell's own stdin reader would read ahead.
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => {
      this.buffer += data;
      const end = this.buffer.indexOf('END\n');
      if (end >= 0 && this.waiter) {
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 4);
        const waiter = this.waiter;
        this.waiter = null;
        waiter(text);
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.on('exit', () => {
      this.child = null;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter('');
      }
    });
  }

  async snapshot(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.ensureChild();
      const text = await new Promise<string>((resolve) => {
        this.waiter = resolve;
        this.child?.stdin.write('\n');
        setTimeout(() => {
          if (this.waiter === resolve) {
            this.waiter = null;
            resolve('');
          }
        }, 15_000);
      });
      if (text) this.parse(text);
    } finally {
      this.busy = false;
    }
  }

  private parse(text: string) {
    const now = Date.now();
    const rows = new Map<number, ProcRow & { cpuPercent: number }>();
    const children = new Map<number, number[]>();
    const agents: AgentProcRow[] = [];
    for (const line of text.split('\n')) {
      const parts = line.replace(/\r$/, '').split('\t');
      if (parts[0] === 'P' && parts.length >= 6) {
        const pid = Number(parts[1]);
        const ppid = Number(parts[2]);
        const cpu = Number(parts[5]) || 0;
        const prev = this.previous.get(pid);
        let cpuPercent = 0;
        if (prev && now > prev.at) {
          const wallTicks = (now - prev.at) * 10_000; // ms -> 100ns
          cpuPercent = Math.max(0, Math.min(100, ((cpu - prev.cpu) / (wallTicks * this.cores)) * 100));
        }
        rows.set(pid, { pid, ppid, name: parts[3], workingSet: Number(parts[4]) || 0, cpu100ns: cpu, cpuPercent });
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid)!.push(pid);
      } else if (parts[0] === 'A' && parts.length >= 5) {
        agents.push({ pid: Number(parts[1]), created: parts[2] || null, exe: parts[3] ?? '', commandLine: parts.slice(4).join(' ') });
      }
    }
    this.previous = new Map([...rows.values()].map((row) => [row.pid, { cpu: row.cpu100ns, at: now }]));
    this.rows = rows;
    this.children = children;
    this.agentRows = agents;
    this.lastSnapshotAt = now;
  }

  /** CPU and memory of a process and everything it spawned. */
  treeResources(rootPid: number): AgentResources | null {
    if (!this.rows.has(rootPid)) return null;
    let cpu = 0;
    let memory = 0;
    let count = 0;
    for (const pid of this.subtree(rootPid)) {
      const row = this.rows.get(pid);
      if (!row) continue;
      cpu += row.cpuPercent;
      memory += row.workingSet;
      count += 1;
    }
    return { cpuPercent: Math.min(100, cpu), memoryMB: memory / (1024 * 1024), processCount: count };
  }

  subtree(rootPid: number): number[] {
    const out: number[] = [];
    const stack = [rootPid];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      for (const child of this.children.get(pid) ?? []) stack.push(child);
    }
    return out;
  }

  /**
   * Claude Code / Codex processes this app did not start: the VS Code
   * extensions, desktop apps, other terminals. Helper and child processes are
   * folded into the outermost agent process of each tree.
   */
  externalAgents(ownedRoots: number[]): ExternalAgentProcess[] {
    const owned = new Set<number>();
    for (const root of ownedRoots) for (const pid of this.subtree(root)) owned.add(pid);
    owned.add(process.pid);
    for (const pid of this.subtree(process.pid)) owned.add(pid);

    const candidates = this.agentRows.filter((row) => {
      if (owned.has(row.pid)) return false;
      const cmd = row.commandLine.toLowerCase();
      if (cmd.includes(' --type=')) return false; // Electron helper processes
      const name = this.rows.get(row.pid)?.name.toLowerCase() ?? '';
      if (name === 'node.exe') return /claude-code|@openai[\\/]codex/.test(cmd);
      if (name === 'claude.exe' && /anthropicclaude[\\/]app-/.test(row.exe.toLowerCase())) return false; // the Claude desktop shell
      return true;
    });
    const candidatePids = new Set(candidates.map((row) => row.pid));
    const result: ExternalAgentProcess[] = [];
    for (const row of candidates) {
      // Skip a process whose ancestor is itself a candidate: it's part of that agent.
      let parent = this.rows.get(row.pid)?.ppid ?? 0;
      let nested = false;
      for (let depth = 0; parent && depth < 12; depth += 1) {
        if (candidatePids.has(parent)) {
          nested = true;
          break;
        }
        parent = this.rows.get(parent)?.ppid ?? 0;
      }
      if (nested) continue;
      const cmd = row.commandLine.toLowerCase();
      const name = this.rows.get(row.pid)?.name ?? '';
      const provider = /codex/.test(cmd) || /codex/i.test(name) ? 'codex' : /claude/.test(cmd) || /claude/i.test(name) ? 'claude' : 'other';
      const resources = this.treeResources(row.pid);
      result.push({
        pid: row.pid,
        provider,
        name: describeAgent(provider, cmd),
        host: this.hostOf(row.pid, row.exe),
        commandLine: row.commandLine,
        startedAt: row.created,
        cpuPercent: resources?.cpuPercent ?? 0,
        memoryMB: resources?.memoryMB ?? 0,
        processCount: resources?.processCount ?? 1
      });
    }
    return result.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  }

  private hostOf(pid: number, exe: string): string {
    const lowerExe = exe.toLowerCase();
    if (lowerExe.includes('\\.vscode\\extensions\\')) return 'VS Code';
    if (lowerExe.includes('\\openai\\codex\\')) return 'Codex desktop';
    if (lowerExe.includes('arco workspace')) return 'Arco Workspace';
    let parent = this.rows.get(pid)?.ppid ?? 0;
    for (let depth = 0; parent && depth < 16; depth += 1) {
      const row = this.rows.get(parent);
      if (!row) break;
      for (const [pattern, label] of HOSTS) {
        if (pattern.test(row.name)) return label;
      }
      if (/^codex\.exe$/i.test(row.name)) return 'Codex desktop';
      parent = row.ppid;
    }
    return 'Unknown';
  }

  dispose() {
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {
      // already gone
    }
  }
}

function describeAgent(provider: string, cmd: string): string {
  if (provider === 'codex') {
    if (cmd.includes('app-server')) return 'Codex app server';
    if (/\sexec(\s|$)/.test(cmd)) return 'Codex exec';
    if (cmd.includes('mcp-server')) return 'Codex MCP server';
    return 'Codex';
  }
  if (provider === 'claude') {
    if (/\s(-p|--print)(\s|$)/.test(cmd)) return 'Claude Code (headless)';
    if (cmd.includes('--output-format') && cmd.includes('stream-json')) return 'Claude Code (SDK)';
    return 'Claude Code';
  }
  return 'Agent';
}

export async function killTree(pid: number) {
  await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000 });
}
