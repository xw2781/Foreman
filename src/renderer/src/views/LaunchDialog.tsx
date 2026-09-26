import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, History, MessagesSquare, Play, Rocket, SquareTerminal, Zap } from 'lucide-react';
import { PROVIDER_LABEL, type AgentMode, type CliDefaults, type LaunchOptions, type Provider } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { colorVar, limitSummary, modelLabel } from '../format';
import { Modal, ProviderIcon, Select, type SelectOption } from '../ui';

/** Newest first; Claude's family aliases (always the latest of each) follow its dated ids. */
export const MODELS: Record<Provider, string[]> = {
  claude: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5', 'opus', 'opus[1m]', 'fable', 'sonnet', 'haiku'],
  codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
};

/** "Default · gpt-6-astra": what the CLI picks when nothing is chosen, from its own config. */
export function defaultLabel(configured: string | null | undefined) {
  return configured ? `Default · ${configured}` : 'CLI default';
}

/** Version numbers in a model id, for newest-first order: claude-opus-4-8 → [4, 8], gpt-5.6-sol → [5, 6]. */
function modelVersion(id: string): number[] {
  const match = /(\d+)(?:[.-](\d{1,2}))?(?![\d])/.exec(id.replace(/-\d{8}/, ''));
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [0, 0];
}

/**
 * Model choices by name, newest first. When the account's CLI config limits
 * the models (Claude's availableModels) only those are offered; `current`
 * (e.g. the id a running session resolved to) is kept when unlisted.
 */
export function modelOptions(provider: Provider, defaults: CliDefaults | null | undefined, current = ''): SelectOption[] {
  const listed = defaults?.models?.length
    ? [...defaults.models].sort((a, b) => {
        const [x, y] = [modelVersion(a), modelVersion(b)];
        return y[0] - x[0] || y[1] - x[1];
      })
    : MODELS[provider];
  const models = [...(current && !listed.includes(current) ? [current] : []), ...listed];
  return [{ value: '', label: defaultLabel(modelLabel(defaults?.model)) }, ...models.map((m) => ({ value: m, label: modelLabel(m) }))];
}

/** "high" → "High": effort values stay lower case for the CLIs, labels don't. */
export function effortLabel(effort: string) {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function effortOptions(provider: Provider, configured: string | null | undefined, current = ''): SelectOption[] {
  const efforts = [...EFFORTS[provider], ...(current && !EFFORTS[provider].includes(current) ? [current] : [])];
  return [{ value: '', label: defaultLabel(configured && effortLabel(configured)) }, ...efforts.map((e) => ({ value: e, label: effortLabel(e) }))];
}

export const EFFORTS: Record<Provider, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh']
};

export const PERMISSIONS: Record<Provider, Array<{ value: string; label: string; hint: string }>> = {
  claude: [
    { value: 'default', label: 'Ask before acting', hint: 'Claude Code asks before edits and commands (your settings apply).' },
    { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits are applied automatically; commands still ask.' },
    { value: 'auto', label: 'Auto', hint: 'A classifier approves safe actions and asks about risky ones.' },
    { value: 'plan', label: 'Plan only', hint: 'Read-only planning; nothing is changed.' },
    { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Never asks. Use only in a sandbox or a throwaway checkout.' }
  ],
  codex: [
    { value: 'approve-for-me', label: 'Approve for me', hint: "Edits the workspace; Codex's auto-reviewer decides when to leave the sandbox instead of asking you." },
    { value: 'auto', label: 'Ask for approval', hint: 'Edits the workspace; asks you before leaving the sandbox.' },
    { value: 'read-only', label: 'Read only', hint: 'Sandboxed read-only access.' },
    { value: 'full-access', label: 'Full access', hint: 'No sandbox, no approvals. Use only in an isolated environment.' },
    { value: 'default', label: 'Codex default', hint: 'Uses the sandbox and approval policy from config.toml.' }
  ]
};

/** What a new agent starts with when the launcher isn't told otherwise. */
export const DEFAULT_PERMISSION: Record<Provider, string> = { claude: 'auto', codex: 'approve-for-me' };

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
  const [mode, setMode] = useState<AgentMode>(preset.mode ?? 'chat');
  const [cwd, setCwd] = useState(preset.cwd ?? settings?.defaultCwd ?? '');
  const [prompt, setPrompt] = useState(preset.prompt ?? '');
  const [title, setTitle] = useState(preset.title ?? '');
  const [model, setModel] = useState(preset.model ?? '');
  const [effort, setEffort] = useState(preset.effort ?? '');
  const [permission, setPermission] = useState(preset.permission ?? DEFAULT_PERMISSION[preset.provider ?? 'claude']);
  const [extraArgs, setExtraArgs] = useState(preset.extraArgs ?? '');
  const [advanced, setAdvanced] = useState(Boolean(preset.model || preset.effort || preset.extraArgs));
  const [busy, setBusy] = useState(false);
  const resuming = Boolean(preset.resumeSessionId);
  // A model or effort from the preset, or picked here, wins over the account's defaults.
  const modelChosen = useRef(preset.model !== undefined);
  const effortChosen = useRef(preset.effort !== undefined);

  // Switching tool resets the account to that tool's active one, and the permissions to its default.
  const initialProvider = useRef(provider);
  useEffect(() => {
    if (!providerProfiles.some((p) => p.id === profileId)) setProfileId(activeId);
    if (provider !== initialProvider.current || !PERMISSIONS[provider].some((p) => p.value === permission)) {
      initialProvider.current = provider;
      setPermission(DEFAULT_PERMISSION[provider]);
      // Another tool's model means nothing here: take the new account's defaults.
      modelChosen.current = false;
      effortChosen.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const profile = providerProfiles.find((p) => p.id === profileId);

  // The account's default model and effort fill the fields until the user picks their own.
  useEffect(() => {
    if (!modelChosen.current) setModel(profile?.defaultModel ?? '');
    if (!effortChosen.current) setEffort(profile?.defaultEffort ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, profile?.defaultModel, profile?.defaultEffort]);
  const modelFromAccount = Boolean(profile?.defaultModel) && model === profile?.defaultModel;
  const effortFromAccount = Boolean(profile?.defaultEffort) && effort === profile?.defaultEffort;
  const modelSummary = [modelLabel(model.trim()), effort ? `${effortLabel(effort)} effort` : ''].filter(Boolean).join(', ');
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
            <Select
              value={profileId}
              onChange={setProfileId}
              disabled={resuming}
              aria-label="Account"
              options={providerProfiles.map((p) => ({
                value: p.id,
                label: p.planTier ? `${p.label} · ${p.planTier}` : p.label,
                hint: p.identity?.email ?? (p.identity?.loggedIn ? undefined : 'Not signed in')
              }))}
            />
            <div className="hint row">
              {profile ? <span className="swatch" style={{ background: colorVar(profile.color), borderRadius: '50%' }} /> : null}
              <span className="ellipsis">{limitSummary(profile?.limits?.windows) || (profile?.planTier ?? profile?.identity?.plan ? `Plan: ${profile?.planTier ?? profile?.identity?.plan}` : 'Plan usage appears after the first session')}</span>
            </div>
          </div>
          <div className="field">
            <label>Mode</label>
            <div className="segmented" style={{ width: '100%' }}>
              <button type="button" className={mode === 'chat' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setMode('chat')}>
                <MessagesSquare size={13} /> Chat
              </button>
              <button type="button" className={mode === 'interactive' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setMode('interactive')}>
                <SquareTerminal size={13} /> Terminal
              </button>
              <button type="button" className={mode === 'task' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setMode('task')} disabled={resuming}>
                <Zap size={13} /> Task
              </button>
            </div>
            <div className="hint">
              {mode === 'chat'
                ? 'A conversation with streaming replies, tool steps, diffs and approvals.'
                : mode === 'interactive'
                  ? "The CLI's own terminal UI, with its slash commands and shortcuts."
                  : 'Runs the prompt headless to completion and reports the result.'}
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
            <label>{mode === 'task' ? 'Task' : mode === 'chat' ? 'Message (optional)' : 'First message (optional)'}</label>
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
            <Select
              value={permission}
              onChange={setPermission}
              aria-label="Permissions"
              options={PERMISSIONS[provider].map((p) => ({ value: p.value, label: p.label, hint: p.hint }))}
            />
            <div className="hint" style={{ color: /never|No sandbox/i.test(permissionHint ?? '') ? 'var(--serious)' : undefined }}>
              {permissionHint}
            </div>
          </div>
        </div>

        <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setAdvanced(!advanced)}>
          <ChevronRight size={14} style={{ transform: advanced ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} /> Model & advanced
          {!advanced && modelSummary ? <span className="muted" style={{ fontWeight: 400 }}>· {modelSummary}</span> : null}
        </button>
        {advanced ? (
          <div className="grid-3" style={{ alignItems: 'start' }}>
            <div className="field">
              <label>Model</label>
              <Select
                value={model}
                aria-label="Model"
                options={modelOptions(provider, profile?.cliDefaults)}
                custom={{ placeholder: 'Other model id…' }}
                onChange={(next) => {
                  modelChosen.current = true;
                  setModel(next);
                }}
              />
              {modelFromAccount ? <div className="hint">This account's default</div> : null}
            </div>
            <div className="field">
              <label>Reasoning effort</label>
              <Select
                value={effort}
                aria-label="Reasoning effort"
                options={effortOptions(provider, profile?.cliDefaults.effort, effort)}
                onChange={(next) => {
                  effortChosen.current = true;
                  setEffort(next);
                }}
              />
              {effortFromAccount ? <div className="hint">This account's default</div> : null}
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
