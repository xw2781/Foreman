import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerUseService } from '../src/main/computerUse';
import type { Profile } from '../src/shared/types';

const SKILL = path.resolve(__dirname, '..', 'resources', 'skills', 'computer-use');

let root: string;
let previousDir: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-cu-'));
  previousDir = process.env.ATC_COMPUTER_USE_DIR;
  process.env.ATC_COMPUTER_USE_DIR = path.join(root, 'state');
});
afterEach(() => {
  if (previousDir === undefined) delete process.env.ATC_COMPUTER_USE_DIR;
  else process.env.ATC_COMPUTER_USE_DIR = previousDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function profile(configDir: string): Profile {
  return { id: 'claude-x', provider: 'claude', label: 'X', color: 'slot-3', configDir, builtin: false, createdAt: '' };
}

describe('computer-use skill', () => {
  it('installs the skill without its self-test and uninstalls it', () => {
    const service = new ComputerUseService(SKILL);
    const p = profile(path.join(root, 'claude'));
    expect(service.isInstalled(p)).toBe(false);
    service.install(p);
    const target = path.join(p.configDir, 'skills', 'computer-use');
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'scripts', 'computer.ps1'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'docs', 'guidance.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'tests'))).toBe(false);
    service.uninstall(p);
    expect(service.isInstalled(p)).toBe(false);
  });

  it('reads the state, action log and last observation the skill writes', () => {
    const state = path.join(root, 'state');
    fs.mkdirSync(state, { recursive: true });
    const shot = path.join(state, 'shots', 'state-1.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    fs.writeFileSync(shot, 'png');
    fs.writeFileSync(
      path.join(state, 'state.json'),
      JSON.stringify({ active: true, agent: 'Claude Code · Work', agent_id: 'a1b2', action: 'Opening the report', started: '2026-09-23T10:00:00Z', heartbeat: '2026-09-23T10:01:00Z', release_requested: true, released_at: '2026-09-23T10:02:00Z', release_source: 'escape' })
    );
    fs.writeFileSync(
      path.join(state, 'actions.jsonl'),
      [
        { timestamp: '2026-09-23T10:00:05Z', agent: 'Claude Code · Work', agent_id: 'a1b2', command: 'click', args: '-Element 12', window: 'Report.xlsx - Excel', process: 'EXCEL', hwnd: 1, code: 0, message: '', duration_ms: 900 },
        { timestamp: '2026-09-23T10:00:09Z', agent: 'Claude Code · Work', agent_id: 'a1b2', command: 'type', args: 'length=12', window: 'Report.xlsx - Excel', process: 'EXCEL', hwnd: 1, code: 3, message: 'Release was requested', duration_ms: 10 }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );
    fs.writeFileSync(path.join(state, 'last_observation.json'), JSON.stringify({ image: { path: shot, originX: 0, originY: 0 } }));
    fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ allowedProcesses: ['EXCEL'], deniedProcesses: [] }));

    const status = new ComputerUseService(SKILL).status();
    expect(status.active).toBe(true);
    expect(status.overlayRunning).toBe(false);
    expect(status.releaseRequested).toBe(true);
    expect(status.releaseSource).toBe('escape');
    expect(status.lastScreenshot).toBe(shot);
    expect(status.policy.allowedProcesses).toEqual(['EXCEL']);
    expect(status.recent[0]).toMatchObject({ command: 'type', code: 3, target: 'Report.xlsx - Excel · EXCEL' });
    expect(status.recent).toHaveLength(2);
  });

  it('writes a normalized app policy', () => {
    const service = new ComputerUseService(SKILL);
    const status = service.setPolicy({ allowedProcesses: ['excel.exe', 'EXCEL', ' notepad '], deniedProcesses: [] });
    expect(status.policy.allowedProcesses).toEqual(['excel', 'notepad']);
  });
});
