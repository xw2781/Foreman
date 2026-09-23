import fs from 'node:fs';
import path from 'node:path';
import type { ComputerUseAction, ComputerUseStatus, Profile } from '../shared/types';
import { exists, readJsonFile, removeTree, run, writeJsonFileAtomic } from './util';

export const SKILL_NAME = 'computer-use';

// The deny list is built into scripts/computer.ps1, which enforces it; the app
// reads it with `policy -Json` at startup. This copy is only the fallback.
export const BUILTIN_DENIED = [
  'WindowsTerminal', 'cmd', 'powershell', 'pwsh', 'conhost', 'OpenConsole', 'wt',
  'powershell_ise', 'mintty', 'ConEmu', 'ConEmu64', 'alacritty', 'wezterm-gui',
  'LockApp', 'consent', 'CredentialUIBroker', 'SecHealthUI', 'SecurityHealthSystray',
  'Taskmgr', 'regedit', 'mmc', '1Password', 'KeePass', 'KeePassXC', 'Bitwarden',
  'Agent Task Center', 'Codex', 'ChatGPT', 'claude'
];

function field<T = unknown>(record: Record<string, any> | null, ...keys: string[]): T | null {
  if (!record) return null;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key] as T;
  }
  return null;
}

export class ComputerUseService {
  readonly stateDir: string;
  private lastKey = '';
  private builtinDenied: string[] = BUILTIN_DENIED;
  onChanged: (status: ComputerUseStatus) => void = () => {};

  constructor(private skillSource: string | null) {
    const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
    this.stateDir = process.env.ATC_COMPUTER_USE_DIR || path.join(appData, 'AgentTaskCenter', 'computer-use');
  }

  get scriptPath(): string | null {
    if (!this.skillSource) return null;
    const script = path.join(this.skillSource, 'scripts', 'computer.ps1');
    return exists(script) ? script : null;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  status(): ComputerUseStatus {
    const state = readJsonFile<Record<string, any>>(path.join(this.stateDir, 'state.json'));
    const policy = readJsonFile<Record<string, any>>(path.join(this.stateDir, 'config.json')) ?? {};
    const observation = readJsonFile<Record<string, any>>(path.join(this.stateDir, 'last_observation.json'));
    const image = observation ? field<string>(observation.image ?? null, 'path') : null;
    return {
      skillSource: this.skillSource,
      stateDir: this.stateDir,
      active: Boolean(state?.active),
      overlayRunning: this.overlayRunning(),
      agent: field<string>(state, 'agent'),
      action: field<string>(state, 'action'),
      startedAt: field<string>(state, 'started'),
      heartbeat: field<string>(state, 'heartbeat'),
      releaseRequested: Boolean(state?.release_requested),
      releasedAt: field<string>(state, 'released_at'),
      releaseSource: field<string>(state, 'release_source'),
      recent: this.recentActions(60),
      lastScreenshot: image && exists(image) ? image : null,
      policy: {
        allowedProcesses: Array.isArray(policy.allowedProcesses) ? policy.allowedProcesses : [],
        deniedProcesses: Array.isArray(policy.deniedProcesses) ? policy.deniedProcesses : []
      },
      builtinDenied: this.builtinDenied
    };
  }

  /** Reads the enforced deny list from the skill itself, so the UI never drifts from it. */
  async loadPolicyFromSkill() {
    const script = this.scriptPath;
    if (!script) return;
    const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'policy', '-Json'], { timeout: 30_000 });
    try {
      const policy = JSON.parse(result.stdout);
      if (Array.isArray(policy.builtinDenied) && policy.builtinDenied.length) {
        this.builtinDenied = policy.builtinDenied;
        this.lastKey = '';
        this.poll();
      }
    } catch {
      // keep the fallback list
    }
  }

  /** The app agent currently driving the screen, when it was launched by this app. */
  currentDriver(): string | null {
    const state = readJsonFile<Record<string, any>>(path.join(this.stateDir, 'state.json'));
    if (!state?.active || !this.overlayRunning()) return null;
    return field<string>(state, 'agent_id');
  }

  private overlayRunning(): boolean {
    try {
      const pid = Number(fs.readFileSync(path.join(this.stateDir, 'overlay.pid'), 'utf8').trim());
      if (!pid) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private recentActions(limit: number): ComputerUseAction[] {
    const file = path.join(this.stateDir, 'actions.jsonl');
    let text: string;
    try {
      const stat = fs.statSync(file);
      const length = Math.min(stat.size, 256 * 1024);
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      fs.closeSync(fd);
      text = buffer.toString('utf8');
    } catch {
      return [];
    }
    const actions: ComputerUseAction[] = [];
    for (const line of text.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      let record: Record<string, any>;
      try {
        record = JSON.parse(line.replace(/^﻿/, ''));
      } catch {
        continue;
      }
      const targetParts = [field<string>(record, 'window', 'target'), field<string>(record, 'process')].filter(Boolean);
      actions.push({
        timestamp: field<string>(record, 'timestamp', 'time', 'ts') ?? '',
        agent: field<string>(record, 'agent'),
        command: field<string>(record, 'command', 'cmd') ?? '?',
        target: targetParts.length ? targetParts.join(' · ') : field<string>(record, 'args', 'detail'),
        code: typeof record.code === 'number' ? record.code : typeof record.exit_code === 'number' ? record.exit_code : null,
        message: field<string>(record, 'message', 'result')
      });
      if (actions.length >= limit) break;
    }
    return actions;
  }

  /** Polled by the main loop; emits only when something visible changed. */
  poll() {
    const status = this.status();
    const key = JSON.stringify([status.active, status.overlayRunning, status.agent, status.action, status.heartbeat, status.releaseRequested, status.recent[0]?.timestamp, status.lastScreenshot, status.policy]);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.onChanged(status);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async command(name: 'release' | 'stop' | 'demo' | 'status'): Promise<{ code: number; output: string }> {
    // `stop` also clears a release; the skill tells agents never to do that themselves.
    const script = this.scriptPath;
    if (!script) throw new Error('The computer-use skill files are missing from this installation.');
    const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, name], {
      timeout: name === 'demo' ? 120_000 : 30_000
    });
    this.poll();
    return { code: result.code, output: `${result.stdout}${result.stderr}`.trim() };
  }

  setPolicy(policy: { allowedProcesses: string[]; deniedProcesses: string[] }) {
    // The skill matches process names case-insensitively, so dedupe the same way.
    const clean = (list: string[]) => {
      const seen = new Set<string>();
      return list
        .map((p) => p.trim().replace(/\.exe$/i, ''))
        .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
    };
    const file = path.join(this.stateDir, 'config.json');
    const existing = readJsonFile<Record<string, any>>(file) ?? {};
    writeJsonFileAtomic(file, { ...existing, allowedProcesses: clean(policy.allowedProcesses), deniedProcesses: clean(policy.deniedProcesses) });
    this.poll();
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Installing the skill into an account
  // -------------------------------------------------------------------------

  skillDir(profile: Profile) {
    return path.join(profile.configDir, 'skills', SKILL_NAME);
  }

  isInstalled(profile: Profile) {
    return exists(path.join(this.skillDir(profile), 'SKILL.md'));
  }

  install(profile: Profile) {
    if (!this.skillSource || !exists(path.join(this.skillSource, 'SKILL.md'))) {
      throw new Error('The computer-use skill files are missing from this installation.');
    }
    const target = this.skillDir(profile);
    if (exists(target)) removeTree(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(this.skillSource, target, {
      recursive: true,
      // The self-test drives a test window; it has no business in an agent's skill folder.
      filter: (source) => !/(^|[\\/])tests([\\/]|$)/.test(path.relative(this.skillSource!, source))
    });
  }

  uninstall(profile: Profile) {
    const target = this.skillDir(profile);
    if (exists(target)) removeTree(target);
  }

  /** Keeps installed copies current after the app itself is updated. */
  refreshInstalled(profiles: Profile[]) {
    if (!this.skillSource) return;
    const sourceStamp = stamp(path.join(this.skillSource, 'scripts'));
    for (const profile of profiles) {
      if (!this.isInstalled(profile)) continue;
      if (stamp(path.join(this.skillDir(profile), 'scripts')) !== sourceStamp) {
        try {
          this.install(profile);
        } catch {
          // Left as-is; the UI still offers a manual reinstall.
        }
      }
    }
  }
}

function stamp(dir: string): string {
  try {
    return fs
      .readdirSync(dir)
      .sort()
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return `${name}:${stat.size}`;
      })
      .join('|');
  } catch {
    return '';
  }
}
