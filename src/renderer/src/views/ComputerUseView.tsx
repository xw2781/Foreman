import { useEffect, useState } from 'react';
import { CheckCircle2, Hand, Image as ImageIcon, Lock, MousePointer2, Play, Plus, Power, ShieldCheck, X, XCircle } from 'lucide-react';
import { PROVIDER_LABEL, type ComputerUseAction } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { ago } from '../format';
import { Empty, Modal, ProviderIcon, Switch, useTicker } from '../ui';

function time(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ActionIcon({ action }: { action: ComputerUseAction }) {
  if (action.code === 0) return <CheckCircle2 size={14} color="var(--good)" />;
  if (action.code === 3) return <Hand size={14} color="var(--warning)" />;
  if (action.code !== null) return <XCircle size={14} color="var(--critical)" />;
  return <MousePointer2 size={14} className="muted" />;
}

function ProcessList({ title, description, items, onChange, placeholder }: { title: string; description: string; items: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const value = draft.trim().replace(/\.exe$/i, '');
    if (value && !items.some((i) => i.toLowerCase() === value.toLowerCase())) onChange([...items, value]);
    setDraft('');
  };
  return (
    <div className="field">
      <label>{title}</label>
      <div className="hint">{description}</div>
      <div className="chips">
        {items.map((item) => (
          <span className="chip" key={item}>
            {item}
            <button onClick={() => onChange(items.filter((i) => i !== item))} aria-label={`Remove ${item}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        {items.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>None</span> : null}
      </div>
      <div className="row">
        <input className="input" style={{ height: 30 }} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={placeholder} />
        <button className="btn sm" onClick={add}>
          <Plus size={13} /> Add
        </button>
      </div>
    </div>
  );
}

export function ComputerUseView() {
  useTicker(5000);
  const status = useApp((s) => s.computerUse);
  const profiles = useApp((s) => s.profiles);
  const toast = useApp((s) => s.toast);
  const [shot, setShot] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (status?.lastScreenshot) {
      call('computerUse.image', status.lastScreenshot).then((data) => !cancelled && setShot(data)).catch(() => {});
    } else setShot(null);
    return () => {
      cancelled = true;
    };
  }, [status?.lastScreenshot, status?.recent[0]?.timestamp]);

  if (!status) return null;
  const live = status.active && status.overlayRunning;
  const released = live && status.releaseRequested;
  // The overlay exits shortly after a release, but the release stays in force until cleared.
  const releasedIdle = status.active && status.releaseRequested && !status.overlayRunning;
  const releaseHow = status.releaseSource === 'escape' ? 'with Esc' : status.releaseSource === 'panel' ? 'with the Release button' : status.releaseSource === 'command' ? 'from this app' : '';

  const command = async (name: 'release' | 'stop' | 'demo') => {
    setBusy(name);
    try {
      const result = await call('computerUse.command', name);
      if (result.code !== 0 && name !== 'release') toast('error', result.output || `${name} failed`);
      else if (name === 'release') toast('success', 'Control released. The agent is told to stop at its next step.');
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setBusy(null);
      useApp.setState({ computerUse: await call('computerUse.status') });
    }
  };

  const setPolicy = async (next: { allowedProcesses: string[]; deniedProcesses: string[] }) => {
    try {
      useApp.setState({ computerUse: await call('computerUse.setPolicy', next) });
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  const install = async (profileId: string, on: boolean) => {
    try {
      useApp.setState({ profiles: await call('computerUse.install', profileId, on) });
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Computer Use</h1>
          <p>Lets Claude Code and Codex see the screen and drive Windows apps with their own on-screen pointer. You can take control back at any moment.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => command('demo')} disabled={busy !== null || live || !status.skillSource} title="Moves the agent pointer around without clicking anything">
            <Play size={14} /> {busy === 'demo' ? 'Running demo…' : 'Show pointer demo'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="cu-hero">
          <div className="cu-state">
            <div className={`cu-orb ${released || releasedIdle ? 'released' : live ? 'live' : ''}`}>
              {released || releasedIdle ? <Hand size={22} /> : <MousePointer2 size={22} />}
            </div>
            <div style={{ display: 'grid', gap: 3 }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>
                {released
                  ? 'Release requested — waiting for the agent to stop'
                  : releasedIdle
                    ? `You took back control${status.agent ? ` from ${status.agent}` : ''}`
                    : live
                      ? `${status.agent ?? 'An agent'} is controlling the computer`
                      : 'No agent is controlling the computer'}
              </div>
              <div className="secondary">
                {releasedIdle ? (
                  <>
                    Released {releaseHow} {status.releasedAt ? ago(status.releasedAt) : ''}. Agents are refused input until you clear it (or an agent is asked to start again).
                  </>
                ) : live ? (
                  <>
                    {status.action ? <span>{status.action}</span> : null}
                    {status.heartbeat ? <span className="muted"> · last step {ago(status.heartbeat)}</span> : null}
                  </>
                ) : (
                  <>When an agent takes control, amber edges and a second pointer appear on screen. Press <span className="kbd">Esc</span> or the panel's Release button to take it back.</>
                )}
              </div>
            </div>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => command('release')} disabled={!live || released || busy !== null} style={{ background: live && !released ? 'var(--warning)' : undefined, color: live && !released ? '#1a1400' : undefined }}>
              <Hand size={15} /> Take back control
            </button>
            {releasedIdle ? (
              <button className="btn" onClick={() => command('stop')} disabled={busy !== null} title="Lets agents use the computer again">
                <Power size={14} /> Clear
              </button>
            ) : (
              <button className="btn danger" onClick={() => command('stop')} disabled={!status.overlayRunning || busy !== null}>
                <Power size={14} /> Turn off overlay
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid-2 section" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-header">
            <h2>Recent actions</h2>
            <span className="sub">From the skill's action log</span>
          </div>
          <div className="card-pad" style={{ maxHeight: 420, overflow: 'auto' }}>
            {status.recent.length === 0 ? (
              <div className="muted">No actions yet.</div>
            ) : (
              <div className="timeline">
                {status.recent.map((action, index) => (
                  <div className="timeline-item" key={`${action.timestamp}-${index}`}>
                    <span className="t">{time(action.timestamp)}</span>
                    <span className="ic">
                      <ActionIcon action={action} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{action.command}</span>
                      {action.target ? <span className="secondary"> · {action.target}</span> : null}
                      {action.message && action.code !== 0 ? <div className="muted ellipsis" title={action.message}>{action.message}</div> : null}
                      {action.agent ? <div className="muted" style={{ fontSize: 11 }}>{action.agent}</div> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Last screenshot</h2>
            <span className="sub">What the agent last looked at</span>
          </div>
          <div className="card-pad">
            {shot ? (
              <img className="cu-shot" src={shot} alt="Latest agent screenshot" onClick={() => setZoom(true)} />
            ) : (
              <Empty icon={<ImageIcon size={20} />} title="No screenshot yet" />
            )}
          </div>
        </div>
      </div>

      <div className="section-title">
        <h2>Skill installation</h2>
        <span className="sub">The skill is plain files an agent reads on demand: SKILL.md plus a PowerShell script</span>
      </div>
      <div className="card">
        {!status.skillSource ? (
          <div className="card-pad" style={{ color: 'var(--critical)' }}>
            The computer-use skill files are missing from this installation.
          </div>
        ) : (
          <div className="settings-list">
            {profiles.map((p) => (
              <div className="setting" key={p.id}>
                <div className="row">
                  <ProviderIcon provider={p.provider} size={22} />
                  <div>
                    <div className="s-title">
                      {PROVIDER_LABEL[p.provider]} · {p.label}
                    </div>
                    <div className="s-desc mono">{`${p.configDir}\\skills\\computer-use`}</div>
                  </div>
                </div>
                <div className="s-control">
                  <span className="muted" style={{ fontSize: 12 }}>
                    {p.skillInstalled ? 'Installed' : 'Not installed'}
                  </span>
                  <Switch on={p.skillInstalled} onChange={(on) => install(p.id, on)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Codex also ships its own Computer Use plugin; installing this skill for a Codex account adds a second option alongside it. Ask an agent to "use the computer-use skill" to start.
      </p>

      <div className="section-title">
        <ShieldCheck size={16} className="muted" />
        <h2>Which apps agents may control</h2>
      </div>
      <div className="card card-pad" style={{ display: 'grid', gap: 18 }}>
        <ProcessList
          title="Allowed apps"
          description="When this list has entries, agents may only click and type into these processes. Leave it empty to allow every app that isn't blocked."
          items={status.policy.allowedProcesses}
          onChange={(allowedProcesses) => setPolicy({ ...status.policy, allowedProcesses })}
          placeholder="Process name, e.g. EXCEL or notepad"
        />
        <ProcessList
          title="Blocked apps"
          description="Agents are refused input into these processes."
          items={status.policy.deniedProcesses}
          onChange={(deniedProcesses) => setPolicy({ ...status.policy, deniedProcesses })}
          placeholder="Process name, e.g. outlook"
        />
        <div className="field">
          <label>Always blocked</label>
          <div className="hint">Terminals, sign-in and security prompts, password managers, Task Manager, and the agent apps themselves. Built into the skill; cannot be turned off here.</div>
          <div className="chips">
            {status.builtinDenied.map((item) => (
              <span className="chip locked" key={item}>
                <Lock size={10} /> {item}
              </span>
            ))}
          </div>
        </div>
      </div>
      {zoom && shot ? (
        <Modal wide title="Last screenshot" onClose={() => setZoom(false)}>
          <img src={shot} alt="Latest agent screenshot" style={{ width: '100%', borderRadius: 8 }} />
        </Modal>
      ) : null}
    </div>
  );
}
