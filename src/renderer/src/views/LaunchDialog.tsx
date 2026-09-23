import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FolderOpen, History, Play, Rocket, SquareTerminal, Zap } from 'lucide-react';
import { PROVIDER_LABEL, type AgentMode, type LaunchOptions, type Provider } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { colorVar, limitSummary } from '../format';
import { Modal, ProviderIcon } from '../ui';

const MODELS: Record<Provider, string[]> = {
  claude: ['opus', 'sonnet', 'fable', 'haiku', 'opus[1m]', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'],
  codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
};

const EFFORTS: Record<Provider, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh']
};

const PERMISSIONS: Record<Provider, Array<{ value: string; label: string; hint: string }>> = {
  claude: [
    { value: 'default', label: 'Ask before acting', hint: 'Claude Code asks before edits and commands (your settings apply).' },
    { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits are applied automatically; commands still ask.' },
    { value: 'auto', label: 'Auto', hint: 'A classifier approves safe actions and asks about risky ones.' },
    { value: 'plan', label: 'Plan only', hint: 'Read-only planning; nothing is changed.' },
    { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Never asks. Use only in a sandbox or a throwaway checkout.' }
  ],
  codex: [
    { value: 'default', label: 'Codex default', hint: 'Uses the sandbox and approval policy from config.toml.' },
    { value: 'read-only', label: 'Read only', hint: 'Sandboxed read-only access.' },
    { value: 'auto', label: 'Workspace write', hint: 'Can edit the workspace; asks before leaving the sandbox.' },
    { value: 'full-access', label: 'Full access', hint: 'No sandbox, no approvals. Use only in an isolated environment.' }
  ]
};

export function LaunchDialog({ preset }: { preset: Partial<LaunchOptions> }) {
  const close = useApp((s) => s.closeLauncher);
  const profiles = useApp((s) => s.profiles);
  const settings = useApp((s) => s.settings);
  const env = useApp((s) => s.env);
  const toast = useApp((s) => s.toast);

  const [provider, setProvider] = useState<Provider>(preset.provider ?? 'claude');
  const providerProfiles = profiles.filter((p) => p.provider === provider);
  const activeId = providerProfiles.find((p) => p.isActive)?.id ?? providerProfiles[0]?.id ?? '';
  const [profileId, setProfileId] = useState(preset.profileId ?? activeId);
  const [mode, setMode] = useState<AgentMode>(preset.mode ?? 'interactive');
  const [cwd, setCwd] = useState(preset.cwd ?? settings?.defaultCwd ?? '');
  const [prompt, setPrompt] = useState(preset.prompt ?? '');
  const [title, setTitle] = useState(preset.title ?? '');
  const [model, setModel] = useState(preset.model ?? '');
  const [effort, setEffort] = useState(preset.effort ?? '');
  const [permission, setPermission] = useState(preset.permission ?? 'default');
  const [extraArgs, setExtraArgs] = useState(preset.extraArgs ?? '');
  const [advanced, setAdvanced] = useState(Boolean(preset.model || preset.effort || preset.extraArgs));
  const [busy, setBusy] = useState(false);
  const resuming = Boolean(preset.resumeSessionId);

  // Switching tool resets the account to that tool's active one.
  useEffect(() => {
    if (!providerProfiles.some((p) => p.id === profileId)) setProfileId(activeId);
    if (!PERMISSIONS[provider].some((p) => p.value === permission)) setPermission('default');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const profile = providerProfiles.find((p) => p.id === profileId);
  const cli = env?.clis.find((c) => c.provider === provider);
  const permissionHint = PERMISSIONS[provider].find((p) => p.value === permission)?.hint;
  const canLaunch = Boolean(profile && cwd.trim() && cli?.path && (mode !== 'task' || prompt.trim()));

  const launch = async () => {
    if (!canLaunch || !profile) return;
    setBusy(true);
    try {
      const agent = await call('agents.launch', {
        provider,
        profileId: profile.id,
        cwd: cwd.trim(),
        mode,
        prompt: prompt.trim() || undefined,
        title: title.trim() || undefined,
        model: model.trim() || undefined,
        effort: effort || undefined,
        permission,
        extraArgs: extraArgs.trim() || undefined,
        resumeSessionId: preset.resumeSessionId
      });
      useApp.setState({ selectedAgentId: agent.id, view: 'agents', launcher: null });
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const picked = await call('dialog.pickDirectory', cwd || undefined);
    if (picked) setCwd(picked);
  };

  const recent = useMemo(() => (settings?.recentCwds ?? []).filter((c) => c !== cwd).slice(0, 6), [settings?.recentCwds, cwd]);

  return (
    <Modal
      wide
      title={resuming ? 'Resume session' : 'New agent'}
      icon={<Rocket size={18} color="var(--accent)" />}
      onClose={close}
      footer={
        <>
          <span className="left">
            <span className="kbd">Ctrl</span> + <span className="kbd">Enter</span> to launch
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canLaunch || busy} onClick={launch}>
            <Play size={14} /> {resuming ? 'Resume' : mode === 'task' ? 'Run task' : 'Launch'}
          </button>
        </>
      }
    >
      <div
        style={{ display: 'contents' }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.ctrlKey) {
            event.preventDefault();
            launch();
          }
        }}
      >
        {resuming ? (
          <div className="badge accent" style={{ justifySelf: 'start', height: 24 }}>
            <History size={13} /> Continuing session {preset.resumeSessionId?.slice(0, 8)}…
          </div>
        ) : (
          <div className="choice-grid">
            {(['claude', 'codex'] as Provider[]).map((p) => {
              const info = env?.clis.find((c) => c.provider === p);
              return (
                <button key={p} className={`choice ${provider === p ? 'on' : ''}`} onClick={() => setProvider(p)}>
                  <ProviderIcon provider={p} size={30} />
                  <div style={{ minWidth: 0 }}>
                    <div className="choice-title">{PROVIDER_LABEL[p]}</div>
                    <div className="choice-sub ellipsis">{info?.path ? `${info.version ?? ''} · ${info.source}` : info?.error ?? 'Not found'}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="grid-2">
          <div className="field">
            <label>Account</label>
            <select className="select" value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={resuming}>
              {providerProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.identity?.email ? ` — ${p.identity.email}` : p.identity?.loggedIn ? '' : ' — not signed in'}
                </option>
              ))}
            </select>
            <div className="hint row">
              {profile ? <span className="swatch" style={{ background: colorVar(profile.color), borderRadius: '50%' }} /> : null}
              <span className="ellipsis">{limitSummary(profile?.limits?.windows) || (profile?.identity?.plan ? `Plan: ${profile.identity.plan}` : 'Plan usage appears after the first session')}</span>
            </div>
          </div>
          <div className="field">
            <label>Mode</label>
            <div className="segmented" style={{ width: '100%' }}>
              <button type="button" className={mode === 'interactive' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setMode('interactive')}>
                <SquareTerminal size={13} /> Interactive
              </button>
              <button type="button" className={mode === 'task' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setMode('task')} disabled={resuming}>
                <Zap size={13} /> Background task
              </button>
            </div>
            <div className="hint">
              {mode === 'interactive' ? 'The full terminal UI; you can chat, approve, and use slash commands.' : 'Runs the prompt headless to completion and reports the result.'}
            </div>
          </div>
        </div>

        <div className="field">
          <label>Working folder</label>
          <div className="row">
            <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\path\to\project" spellCheck={false} />
            <button className="btn" onClick={browse}>
              <FolderOpen size={14} /> Browse
            </button>
          </div>
          {recent.length ? (
            <div className="chips">
              {recent.map((r) => (
                <button key={r} className="chip" style={{ cursor: 'pointer', paddingRight: 9 }} onClick={() => setCwd(r)} title={r}>
                  {r.split(/[\\/]/).filter(Boolean).pop()}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {!resuming ? (
          <div className="field">
            <label>{mode === 'task' ? 'Task' : 'First message (optional)'}</label>
            <textarea
              className="textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={mode === 'task' ? 'Describe what the agent should do. It runs until done.' : 'Leave empty to start at the prompt.'}
              autoFocus
            />
          </div>
        ) : null}

        <div className="grid-2">
          <div className="field">
            <label>Name (optional)</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shown in the task manager" />
          </div>
          <div className="field">
            <label>Permissions</label>
            <select className="select" value={permission} onChange={(e) => setPermission(e.target.value)}>
              {PERMISSIONS[provider].map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <div className="hint" style={{ color: /never|No sandbox/i.test(permissionHint ?? '') ? 'var(--serious)' : undefined }}>
              {permissionHint}
            </div>
          </div>
        </div>

        <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setAdvanced(!advanced)}>
          <ChevronRight size={14} style={{ transform: advanced ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} /> Model & advanced
        </button>
        {advanced ? (
          <div className="grid-3">
            <div className="field">
              <label>Model</label>
              <input className="input" list={`models-${provider}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="CLI default" />
              <datalist id={`models-${provider}`}>
                {MODELS[provider].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label>Reasoning effort</label>
              <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">CLI default</option>
                {EFFORTS[provider].map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Extra arguments</label>
              <input className="input mono" value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder={provider === 'claude' ? '--add-dir ..\\shared' : '--search'} spellCheck={false} />
            </div>
          </div>
        ) : null}
        {!cli?.path ? <div className="badge critical" style={{ justifySelf: 'start' }}>{cli?.error ?? `${PROVIDER_LABEL[provider]} CLI not found`}</div> : null}
        {profile && profile.identity && !profile.identity.loggedIn ? (
          <div className="badge warning" style={{ justifySelf: 'start' }}>
            This account isn't signed in yet; the CLI will ask you to sign in.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
