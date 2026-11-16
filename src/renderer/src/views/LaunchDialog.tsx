import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Folder, FolderOpen, History, Monitor, Play, Rocket, X } from 'lucide-react';
import { PROVIDER_LABEL, type CliDefaults, type LaunchOptions, type Provider } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { colorVar, limitSummary, modelLabel, signedOutLabel } from '../format';
import { Modal, ProviderIcon, Select, type SelectOption } from '../ui';
import { defaultModel, modelChoices, olderModelIds } from '@shared/models';

/** Newest first; Claude's family aliases (always the latest of each) follow its dated ids. */
export { MODELS } from '@shared/models';

/** "Default · gpt-6-astra": what the CLI picks when nothing is chosen, from its own config. */
export function defaultLabel(configured: string | null | undefined) {
  return configured ? `Default · ${configured}` : 'CLI default';
}


/**
 * Live CLI choices in provider order, otherwise newest first. When the account's CLI config limits
 * the models (Claude's availableModels) only those are offered; `current`
 * (e.g. the id a running session resolved to) is kept when unlisted.
 */
export function modelOptions(provider: Provider, defaults: CliDefaults | null | undefined, current = ''): SelectOption[] {
  const older = olderModelIds(provider, defaults, current);
  return modelChoices(provider, defaults, current).map((m) => {
    const discovered = defaults?.discoveredModels?.find((model) => model.id === m);
    const resolved = discovered?.resolvedModel;
    const label = resolved
      ? `${m === 'default' ? 'Default · ' : ''}${modelLabel(resolved + (m.endsWith('[1m]') && !resolved.endsWith('[1m]') ? '[1m]' : ''))}`
      : discovered?.label || modelLabel(m);
    return { value: m, label, ...(older.has(m) ? { collapsedGroup: 'Older models' } : {}) };
  });
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

/** The tool picked last in the launcher, so the next new agent starts on it. */
function lastProvider(): Provider {
  try {
    const saved = localStorage.getItem('launcherProvider');
    if (saved === 'claude' || saved === 'codex') return saved;
  } catch { /* storage unavailable */ }
  return 'claude';
}

function rememberProvider(p: Provider) {
  try { localStorage.setItem('launcherProvider', p); } catch { /* storage unavailable */ }
}

/** One setting of the launcher: its name on the left, the control and any note on the right. */
function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="launch-row">
      {htmlFor ? <label className="launch-label" htmlFor={htmlFor}>{label}</label> : <div className="launch-label">{label}</div>}
      <div className="launch-ctl">{children}</div>
    </div>
  );
}

export function LaunchDialog({ preset }: { preset: Partial<LaunchOptions> }) {
  const close = useApp((s) => s.closeLauncher);
  const profiles = useApp((s) => s.profiles);
  const settings = useApp((s) => s.settings);
  const env = useApp((s) => s.env);
  const toast = useApp((s) => s.toast);

  const [provider, setProvider] = useState<Provider>(preset.provider ?? lastProvider());
  const providerProfiles = profiles.filter((p) => p.provider === provider);
  const activeId = providerProfiles.find((p) => p.isActive)?.id ?? providerProfiles[0]?.id ?? '';
  const [profileId, setProfileId] = useState(preset.profileId ?? activeId);
  // An empty folder means no project: the chat gets a workspace of its own.
  const [cwd, setCwd] = useState(preset.projectless ? '' : preset.cwd ?? settings?.defaultCwd ?? '');
  const [title, setTitle] = useState(preset.title ?? '');
  const [model, setModel] = useState(preset.model ?? '');
  const [effort, setEffort] = useState(preset.effort ?? '');
  const [permission, setPermission] = useState(preset.permission ?? DEFAULT_PERMISSION[provider]);
  const [extraArgs, setExtraArgs] = useState(preset.extraArgs ?? '');
  const [advanced, setAdvanced] = useState(Boolean(preset.extraArgs || preset.title || preset.permission));
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
    if (!modelChosen.current) setModel(profile?.defaultModel || defaultModel(provider, profile?.cliDefaults));
    if (!effortChosen.current) setEffort(profile?.defaultEffort ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, profile?.defaultModel, profile?.defaultEffort, profile?.cliDefaults, provider]);
  const modelFromAccount = Boolean(profile?.defaultModel) && model === profile?.defaultModel;
  const effortFromAccount = Boolean(profile?.defaultEffort) && effort === profile?.defaultEffort;
  const accountDefaults = modelFromAccount && effortFromAccount
    ? "This account's default model and effort"
    : modelFromAccount ? "This account's default model" : effortFromAccount ? "This account's default effort" : null;
  const permissionLabel = PERMISSIONS[provider].find((p) => p.value === permission)?.label;
  const moreSummary = [permissionLabel, title.trim(), extraArgs.trim()].filter(Boolean).join(', ');
  const cli = env?.clis.find((c) => c.provider === provider);
  const permissionHint = PERMISSIONS[provider].find((p) => p.value === permission)?.hint;
  const withoutProject = !cwd.trim();
  // Where chats without a project work (`resolveChatWorkspace`): one folder each under this one.
  const workspaces = `${env?.userDataDir ?? ''}\\chat-workspaces`;
  const canLaunch = Boolean(profile && cli?.path);

  const launch = async () => {
    if (!canLaunch || !profile) return;
    setBusy(true);
    try {
      const agent = await call('agents.launch', {
        provider,
        profileId: profile.id,
        cwd: withoutProject ? '' : cwd.trim(),
        projectless: withoutProject,
        mode: 'chat',
        prompt: preset.prompt?.trim() || undefined,
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

  const recent = useMemo(
    () => (settings?.recentCwds ?? []).map((folder) => ({ value: folder, label: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, hint: folder })),
    [settings?.recentCwds]
  );
  const cliInfo = cli?.path ? cli.version : null;
  const usage = limitSummary(profile?.limits?.windows) || (profile?.planTier ?? profile?.identity?.plan ? `Plan: ${profile?.planTier ?? profile?.identity?.plan}` : 'Plan usage appears after the first session');
  // Every account of both tools, Claude's first: picking one picks its tool.
  const accounts = (['claude', 'codex'] as Provider[]).flatMap((tool) =>
    profiles.filter((p) => p.provider === tool).map((p) => ({
      value: p.id,
      label: [PROVIDER_LABEL[tool], p.label, p.planTier].filter(Boolean).join(' · '),
      hint: p.identity?.email ?? (p.identity?.loggedIn ? undefined : signedOutLabel(p.identity))
    }))
  );
  const pickAccount = (id: string) => {
    const picked = profiles.find((p) => p.id === id);
    if (!picked) return;
    rememberProvider(picked.provider);
    setProvider(picked.provider);
    setProfileId(id);
  };

  return (
    <Modal
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
            <Play size={14} /> {resuming ? 'Resume' : 'Launch'}
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
        <div className="launch-rows">
          <Row label="Account">
            <Select
              value={profileId}
              onChange={pickAccount}
              disabled={resuming}
              icon={<ProviderIcon provider={provider} size={16} />}
              aria-label="Tool and account"
              options={accounts}
            />
            <div className="hint row">
              {profile ? <span className="swatch" style={{ background: colorVar(profile.color), borderRadius: '50%' }} /> : null}
              <span className="ellipsis">{[usage, cliInfo].filter(Boolean).join(' · ')}</span>
            </div>
            {resuming ? (
              <div className="badge accent" style={{ justifySelf: 'start', height: 24 }}>
                <History size={13} /> Continuing session {preset.resumeSessionId?.slice(0, 8)}…
              </div>
            ) : null}
          </Row>

          <Row label="Project" htmlFor="launch-project">
            <div className="path-row">
              <div className="path-box">
                {withoutProject ? <Monitor size={14} className="path-icon" /> : <Folder size={14} className="path-icon" />}
                <input id="launch-project" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={`This Computer (${workspaces})`} title={withoutProject ? workspaces : undefined} spellCheck={false} />
                {withoutProject ? null : (
                  <button type="button" className="btn ghost sm icon" title="This Computer (no project)" aria-label="Clear project" onClick={() => setCwd('')}>
                    <X size={14} />
                  </button>
                )}
                {recent.length ? (
                  <Select
                    className="path-recent"
                    variant="ghost"
                    size="sm"
                    heading="Recent projects"
                    title="Recent projects"
                    aria-label="Recent projects"
                    value={recent.some((r) => r.value === cwd) ? cwd : ''}
                    options={recent}
                    onChange={setCwd}
                  />
                ) : null}
              </div>
              <button type="button" className="btn path-browse" onClick={browse}>
                <FolderOpen size={14} /> Browse
              </button>
            </div>
            {withoutProject ? <div className="hint">No project: the chat works in a folder of its own there.</div> : null}
          </Row>

          <div className="launch-rule" />

          <Row label="Model">
            <div className="launch-pair">
              <Select
                value={model || defaultModel(provider, profile?.cliDefaults)}
                aria-label="Model"
                options={modelOptions(provider, profile?.cliDefaults, model)}
                custom={{ placeholder: 'Other model id…' }}
                onChange={(next) => {
                  modelChosen.current = true;
                  setModel(next);
                }}
              />
              <Select
                value={effort}
                prefix="Effort"
                aria-label="Reasoning effort"
                options={effortOptions(provider, profile?.cliDefaults.effort, effort)}
                onChange={(next) => {
                  effortChosen.current = true;
                  setEffort(next);
                }}
              />
            </div>
            {accountDefaults ? <div className="hint">{accountDefaults}</div> : null}
          </Row>

          <button type="button" className="btn ghost sm launch-more" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            <ChevronRight size={14} style={{ transform: advanced ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} /> More options
            {!advanced && moreSummary ? <span className="muted ellipsis" style={{ fontWeight: 400 }}>· {moreSummary}</span> : null}
          </button>

          {advanced ? (
            <>
            <Row label="Permissions">
              <Select
                value={permission}
                onChange={setPermission}
                aria-label="Permissions"
                options={PERMISSIONS[provider].map((p) => ({ value: p.value, label: p.label, hint: p.hint }))}
              />
              <div className="hint" style={{ color: /never|No sandbox/i.test(permissionHint ?? '') ? 'var(--serious)' : undefined }}>
                {permissionHint}
              </div>
            </Row>
              <Row label="Chat title" htmlFor="launch-title">
                <input id="launch-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shown in the task manager" />
              </Row>
              <Row label="Extra arguments" htmlFor="launch-args">
                <input id="launch-args" className="input mono" value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder={provider === 'claude' ? '--add-dir ..\\shared' : '--search'} spellCheck={false} />
              </Row>
            </>
          ) : null}
        </div>
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
