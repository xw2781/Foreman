import { useEffect, useState } from 'react';
import { Download, FolderOpen, RefreshCw } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type AppSettings, type PricingStatus, type UpdateStatus } from '@shared/types';
import { call, errorMessage, listen } from '../api';
import { useApp } from '../store';
import { usd } from '../format';
import { VOICE_MODELS, voiceModel } from '@shared/voiceModels';
import { describeVoiceStatus, prepareVoiceModel, useVoiceStatus } from '../voice/engine';
import { Segmented, Select, Switch, confirmDialog } from '../ui';

function Setting({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div className="s-title">{title}</div>
        {description ? <div className="s-desc">{description}</div> : null}
      </div>
      <div className="s-control">{children}</div>
    </div>
  );
}

function updateText(update: UpdateStatus | null): string {
  switch (update?.state) {
    case 'unsupported':
      return 'Development build: updates apply only to the installed app.';
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return 'Up to date.';
    case 'downloading':
      return `Downloading ${update.version}… ${Math.round(update.percent ?? 0)}%`;
    case 'ready':
      return `Version ${update.version} is ready. Restarting installs it; it also installs the next time you quit.`;
    case 'error':
      return `Couldn't check for updates: ${update.error}`;
    default:
      return 'Checks GitHub for new versions every few hours and downloads them in the background.';
  }
}

export function SettingsView() {
  const settings = useApp((s) => s.settings)!;
  const env = useApp((s) => s.env);
  const appUpdate = useApp((s) => s.update);
  const toast = useApp((s) => s.toast);
  const priceMismatches = useApp((s) => s.usage?.priceMismatches) ?? [];
  const [overrideModel, setOverrideModel] = useState('');
  const [overrideSize, setOverrideSize] = useState('');
  const [pricing, setPricing] = useState<PricingStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const manageCli = async (provider: 'claude' | 'codex', operation: 'cli.install' | 'cli.rollback') => {
    setInstalling(provider);
    try {
      useApp.setState({ env: await call(operation, provider) });
      toast('success', `${PROVIDER_LABEL[provider]} is ready for new sessions.`);
    } catch (error) { toast('error', errorMessage(error)); }
    finally { setInstalling(null); }
  };

  useEffect(() => {
    call('pricing.status').then(setPricing, () => {});
    return listen('pricing', setPricing);
  }, []);

  const editPricing = async () => {
    try {
      setPricing(await call('pricing.edit'));
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  const update = async (patch: Partial<AppSettings>) => {
    try {
      useApp.setState({ settings: await call('settings.update', patch) });
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };

  const refreshClis = async () => useApp.setState({ env: await call('env.refreshClis') });

  const pickCli = async (provider: 'claude' | 'codex') => {
    const file = await call('dialog.pickFile', `Choose the ${PROVIDER_LABEL[provider]} executable`);
    if (file) {
      await update({ cliPath: { ...settings.cliPath, [provider]: file } });
      await refreshClis();
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Stored in {env?.userDataDir}</p>
        </div>
      </div>

      <div className="section-title">
        <h2>Command-line tools</h2>
        <div className="actions">
          <button className="btn sm" onClick={refreshClis}>
            <RefreshCw size={13} /> Detect again
          </button>
        </div>
      </div>
      <div className="card settings-list">
        <div className="card-pad muted">Install tools for Foreman on this PC. Downloads are verified and updates apply to new sessions. Account sign-ins and transcripts stay in their separate folders.</div>
        {PROVIDERS.map((provider) => {
          const cli = env?.clis.find((c) => c.provider === provider);
          return (
            <Setting
              key={provider}
              title={PROVIDER_LABEL[provider]}
              description={
                cli?.path ? (
                  <>
                    <span className="mono">{cli.path}</span>
                    <br />
                    {cli.version} · found via {cli.source}
                  </>
                ) : (
                  <span style={{ color: 'var(--critical)' }}>{cli?.error}</span>
                )
              }
            >
              <button className="btn sm primary" disabled={!!installing} onClick={() => manageCli(provider, 'cli.install')}>
                <Download size={13} /> {installing === provider ? 'Setting up…' : cli?.source === 'Foreman managed' ? 'Update managed CLI' : 'Install for Foreman'}
              </button>
              {cli?.source === 'Foreman managed' ? <button className="btn sm" disabled={!!installing} onClick={() => manageCli(provider, 'cli.rollback')}>Roll back</button> : null}
              {settings.cliPath[provider] ? (
                <button className="btn sm" onClick={async () => { await update({ cliPath: { ...settings.cliPath, [provider]: '' } }); await refreshClis(); }}>
                  Use auto-detect
                </button>
              ) : null}
              <button className="btn sm" onClick={() => pickCli(provider)}>
                <FolderOpen size={13} /> Choose…
              </button>
            </Setting>
          );
        })}
        <Setting title="Keep installed tools up to date" description="Checks every few hours for a new release of tools installed for Foreman, so new models show up. Rolling back pauses this until you update by hand.">
          <Switch on={settings.autoUpdateClis} onChange={(v) => update({ autoUpdateClis: v })} />
        </Setting>
        <Setting title="Launch isolated Codex accounts without the shared daemon" description="Passes --no-daemon so a second account never attaches to a background app-server started under another account.">
          <Switch on={settings.codexNoDaemonForIsolated} onChange={(v) => update({ codexNoDaemonForIsolated: v })} />
        </Setting>
        <Setting
          title="Capture Claude Code's status line"
          description="Claude sessions started here report their exact context size, cost and 5-hour/weekly plan usage to the app. Your own status-line command still runs and is shown as before."
        >
          <Switch on={settings.claudeStatusLine} onChange={(v) => update({ claudeStatusLine: v })} />
        </Setting>
        <Setting
          title="Compact idle Claude conversations"
          description="When a long conversation sits idle, Claude Code may compact it about 54 minutes after the last reply, shortly before its prompt cache expires, so coming back doesn't re-send the whole context at full price. Anthropic rolls this out per account. This is the default for new sessions; change one session's in its side panel (Details), where a chat can also keep its cache warm for some hours first. Your Claude Code settings are not changed."
        >
          <Switch on={settings.claudeIdleMode !== 'off'} onChange={(v) => update({ claudeIdleMode: v ? 'compact' : 'off' })} />
        </Setting>
        <Setting
          title="Idle compaction threshold"
          description="Only conversations at least this large are compacted while idle, or kept warm. Applies to sessions started after the change."
        >
          <Select
            style={{ width: 220 }}
            aria-label="Idle compaction threshold"
            disabled={settings.claudeIdleMode === 'off'}
            value={String(settings.claudeIdleCompactMinTokens ?? 0)}
            onChange={(value) => update({ claudeIdleCompactMinTokens: Number(value) })}
            options={[
              { value: '0', label: 'Claude Code default', hint: '200K tokens unless Anthropic sets otherwise' },
              { value: '100000', label: '100K tokens' },
              { value: '200000', label: '200K tokens' },
              { value: '400000', label: '400K tokens' },
              { value: '600000', label: '600K tokens' },
              { value: '800000', label: '800K tokens' }
            ]}
          />
        </Setting>
        <Setting title="Shell for account terminals" description="Used by “Terminal as this account”.">
          <Select
            style={{ width: 220 }}
            aria-label="Shell for account terminals"
            value={settings.shellForTerminals}
            onChange={(shellForTerminals) => update({ shellForTerminals })}
            options={[
              { value: 'powershell.exe', label: 'Windows PowerShell' },
              { value: 'pwsh.exe', label: 'PowerShell 7 (pwsh)' },
              { value: 'cmd.exe', label: 'Command Prompt' }
            ]}
          />
        </Setting>
      </div>

      <div className="section-title">
        <h2>Appearance</h2>
      </div>
      <div className="card settings-list">
        <Setting title="Theme">
          <Segmented
            value={settings.theme}
            onChange={(theme) => update({ theme })}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' }
            ]}
          />
        </Setting>
        <Setting title="Light palette" description="Used by Light, and by System when Windows is in light mode.">
          <Segmented
            value={settings.lightPalette}
            onChange={(lightPalette) => update({ lightPalette })}
            options={[
              { value: 'cream', label: 'Cream' },
              { value: 'grey', label: 'Pro grey' }
            ]}
          />
        </Setting>
        <Setting title="Terminal font size">
          <input className="input" type="number" min={9} max={24} style={{ width: 90 }} value={settings.terminalFontSize} onChange={(e) => update({ terminalFontSize: Math.max(9, Math.min(24, Number(e.target.value) || 13)) })} />
        </Setting>
        <Setting title="Terminal font" description="Any installed monospace font, as a CSS font-family list.">
          <input className="input mono" value={settings.terminalFontFamily} onChange={(e) => update({ terminalFontFamily: e.target.value })} />
        </Setting>
      </div>

      <div className="section-title">
        <h2>Chat</h2>
      </div>
      <div className="card settings-list">
        <Setting title="Chat font size" description="Message text and chat input, in pixels. Applies immediately.">
          <input className="input" type="number" min={10} max={24} step={0.5} aria-label="Chat font size" style={{ width: 90 }}
            value={settings.chatFontSize ?? 13.5}
            onChange={(e) => {
              const size = e.target.valueAsNumber;
              if (Number.isFinite(size)) update({ chatFontSize: Math.max(10, Math.min(24, size)) });
            }} />
          <button className="btn sm" onClick={() => update({ chatFontSize: 13.5 })}>Reset</button>
        </Setting>
        <Setting
          title="Messages sent while an agent works"
          description="Steer: the message goes into the running turn, and the agent reads it after its current step. Queue: it waits above the message box and goes as the next prompt when the turn ends. Ctrl+Enter sends the other way; each chat can also switch."
        >
          <Segmented
            value={settings.chatSendMode}
            onChange={(chatSendMode) => update({ chatSendMode })}
            options={[
              { value: 'steer', label: 'Steer' },
              { value: 'queue', label: 'Queue' }
            ]}
          />
        </Setting>
        <Setting
          title="Suggested next steps"
          description="When an agent finishes with a list of recommended next steps, show them as cards under its reply: click one to send it, or add a comment first."
        >
          <Switch on={settings.chatNextSteps !== false} onChange={(v) => update({ chatNextSteps: v })} />
        </Setting>
        <Setting
          title="Show thinking"
          description="Show an agent's thinking expanded in the chat. Turn off to fold it under a Thought line you can click to open."
        >
          <Switch on={settings.chatShowThinking !== false} onChange={(v) => update({ chatShowThinking: v })} />
        </Setting>
        <Setting
          title="Voice input model"
          description="The speech-to-text model behind the microphone button. It runs on this computer; a larger model is more accurate but slower and downloads once on first use. Dictated messages also tell the agent to correct mishearings from context."
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <Select
              style={{ width: 260 }}
              aria-label="Voice input model"
              value={voiceModel(settings.voiceModel).id}
              onChange={(model) => { update({ voiceModel: model }); prepareVoiceModel(model); }}
              options={VOICE_MODELS.map((m) => ({ value: m.id, label: `${m.label} · ${m.size}`, hint: m.hint }))}
            />
            <VoiceModelStatus />
          </div>
        </Setting>
      </div>

      <div className="section-title">
        <h2>Agent browser</h2>
      </div>
      <div className="card settings-list">
        <Setting
          title="Give agents Foreman's browser"
          description="New Claude Code and Codex agents get browser tools for a Chromium browser inside Foreman. It runs off-screen with its own cookies and logins, apart from your browsers, so it never takes your screen, mouse or keyboard. Watch it (and take over) in the Browser tab of the side panel beside an agent."
        >
          <Switch on={settings.browserEnabled} onChange={(v) => update({ browserEnabled: v })} />
        </Setting>
        <Setting title="Let agents use it without asking" description="Otherwise each browser step asks for approval like any other tool. Applies to agents started after the change.">
          <Switch on={settings.browserAutoApprove} onChange={(v) => update({ browserAutoApprove: v })} />
        </Setting>
        <Setting
          title="Browser profile"
          description="Shared: every agent uses one agent profile, so a site you sign in to there stays signed in for all agents. Separate: each agent starts signed out, and its data is cleared when the agent is removed."
        >
          <Segmented
            value={settings.browserProfile}
            onChange={(browserProfile) => update({ browserProfile })}
            options={[
              { value: 'shared', label: 'Shared' },
              { value: 'per-agent', label: 'Separate per agent' }
            ]}
          />
        </Setting>
        <Setting title="Show the browser when an agent starts using it" description="Switches the side panel beside the conversation to the Browser tab; you can close it at any time.">
          <Switch on={settings.browserAutoOpen} onChange={(v) => update({ browserAutoOpen: v })} />
        </Setting>
        <Setting title="Agent browsing data" description="Cookies, logins, site storage and cache of the agent browser. Your own browsers are never touched.">
          <button className="btn sm" onClick={() => call('browser.clearData').catch((error) => toast('error', errorMessage(error)))}>
            Clear browsing data
          </button>
        </Setting>
      </div>

      <div className="section-title">
        <h2>Notifications & safety</h2>
      </div>
      <div className="card settings-list">
        <Setting title="Notify when an agent needs input" description="A desktop notification when an agent waits for an approval or answer while the app is in the background.">
          <Switch on={settings.notifyOnNeedsInput} onChange={(v) => update({ notifyOnNeedsInput: v })} />
        </Setting>
        <Setting title="Notify when a turn or task finishes">
          <Switch on={settings.notifyOnTurnComplete} onChange={(v) => update({ notifyOnTurnComplete: v })} />
        </Setting>
        <Setting title="Confirm before stopping agents" description="Also asks before quitting while agents are running.">
          <Switch on={settings.confirmBeforeStop} onChange={(v) => update({ confirmBeforeStop: v })} />
        </Setting>
      </div>

      <div className="section-title">
        <h2>Context & cost</h2>
      </div>
      <div className="card settings-list">
        <Setting
          title="Assumed Claude context window"
          description="Used when neither Claude Code nor the model table reports a window size for a session."
        >
          <Select
            style={{ width: 220 }}
            aria-label="Assumed Claude context window"
            value={String(settings.claudeContextWindow)}
            onChange={(value) => update({ claudeContextWindow: Number(value) })}
            options={[
              { value: '200000', label: '200K tokens' },
              { value: '1000000', label: '1M tokens' },
              { value: '0', label: "Don't assume", hint: 'No context % for unknown windows' }
            ]}
          />
        </Setting>
        <Setting title="Per-model context window" description="Overrides the window size for one model id, e.g. claude-sonnet-5 → 200000.">
          <div style={{ display: 'grid', gap: 6, width: '100%' }}>
            {Object.entries(settings.contextWindowOverrides).map(([model, size]) => (
              <div className="row" key={model}>
                <span className="mono ellipsis" style={{ flex: 1 }}>
                  {model}
                </span>
                <span className="num">{size.toLocaleString()}</span>
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    const next = { ...settings.contextWindowOverrides };
                    delete next[model];
                    update({ contextWindowOverrides: next });
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <input className="input mono" style={{ height: 30 }} placeholder="model id" value={overrideModel} onChange={(e) => setOverrideModel(e.target.value)} />
              <input className="input" style={{ height: 30, width: 110 }} placeholder="tokens" value={overrideSize} onChange={(e) => setOverrideSize(e.target.value)} />
              <button
                className="btn sm"
                disabled={!overrideModel.trim() || !(Number(overrideSize) > 0)}
                onClick={() => {
                  update({ contextWindowOverrides: { ...settings.contextWindowOverrides, [overrideModel.trim()]: Number(overrideSize) } });
                  setOverrideModel('');
                  setOverrideSize('');
                }}
              >
                Add
              </button>
            </div>
          </div>
        </Setting>
        <Setting
          title="Model prices"
          description={
            <>
              API-equivalent cost estimates use prices checked {pricing?.pricingDate || '…'} ({pricing?.models ?? '…'} models).{' '}
              {pricing?.exists ? 'Your pricing.json is applied over the built-in table' : 'Edit prices to add models or correct rates without waiting for an app update'}; changes apply when the file is saved.
              {pricing?.error ? <span style={{ color: 'var(--critical)' }}> {pricing.error}</span> : null}
              {pricing?.problems.length ? <span style={{ color: 'var(--critical)' }}> Skipped: {pricing.problems.join('; ')}</span> : null}
              {priceMismatches.map((m) => (
                <span key={m.model} style={{ display: 'block', color: 'var(--critical)' }}>
                  Claude Code{m.cliVersion ? ` ${m.cliVersion}` : ''} prices {m.model} differently: {usd(m.reportedUsd)} for tokens this table prices at {usd(m.tableUsd)} (
                  {m.tableUsd > m.reportedUsd ? '+' : '−'}
                  {Math.round((Math.abs(m.tableUsd - m.reportedUsd) / m.reportedUsd) * 100)}%). Check the model’s rates, or update Claude Code if it’s the one out of date.
                </span>
              ))}
            </>
          }
        >
          <div className="row">
            {pricing?.exists ? (
              <button className="btn ghost sm" onClick={() => call('shell.showItem', pricing.path)}>
                <FolderOpen size={14} /> Show file
              </button>
            ) : null}
            <button className="btn sm" onClick={editPricing}>
              Edit prices
            </button>
          </div>
        </Setting>
      </div>

      <DataStorage />

      <div className="section-title">
        <h2>Updates</h2>
      </div>
      <div className="card settings-list">
        <Setting title={`Foreman ${env?.appVersion ?? ''}`} description={updateText(appUpdate)}>
          {appUpdate?.state === 'ready' ? (
            <button className="btn primary sm" onClick={() => call('update.install').catch((error) => toast('error', errorMessage(error)))}>
              <Download size={13} /> Restart to update
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={!appUpdate || appUpdate.state === 'unsupported' || appUpdate.state === 'checking' || appUpdate.state === 'downloading'}
              onClick={() => call('update.check').then((update) => useApp.setState({ update })).catch((error) => toast('error', errorMessage(error)))}
            >
              <RefreshCw size={13} /> Check for updates
            </button>
          )}
        </Setting>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
        Foreman {env?.appVersion} · Accounts live in {env?.profilesDir} · Claude hooks endpoint {env?.hookServer ?? 'unavailable'}
      </p>
    </div>
  );
}

/** Where account folders and screenshots are kept, and for how long Claude Code keeps transcripts. */
function DataStorage() {
  const settings = useApp((s) => s.settings)!;
  const toast = useApp((s) => s.toast);
  const [moving, setMoving] = useState(false);
  const [days, setDays] = useState(String(settings.claudeSessionRetentionDays));
  useEffect(() => setDays(String(settings.claudeSessionRetentionDays)), [settings.claudeSessionRetentionDays]);

  const move = async (dir: string) => {
    const { ok } = await confirmDialog({
      title: dir ? 'Move Foreman\'s data?' : 'Move the data back?',
      message: dir ? (
        <>
          Every account folder (transcripts, settings, sign-in and all) moves to <span className="mono">{dir}</span>, one folder per account, and computer-use
          screenshots and logs to its <span className="mono">computer-use</span> folder. Each is linked back from its usual place, so Claude Code, Codex and
          resuming sessions work as before. Close Claude Code and Codex everywhere first, including VS Code. Moving to another drive copies everything and can
          take a while.
        </>
      ) : (
        'Each account folder and the computer-use folder move back to their usual places. Close Claude Code and Codex everywhere first, including VS Code.'
      ),
      confirmLabel: 'Move'
    });
    if (!ok) return;
    setMoving(true);
    try {
      useApp.setState({ settings: await call('dataDir.move', dir) });
      toast('success', 'Data moved.');
    } catch (error) {
      toast('error', errorMessage(error));
      useApp.setState({ settings: await call('settings.get') });
    } finally {
      setMoving(false);
    }
  };

  const choose = async () => {
    const dir = await call('dialog.pickDirectory', settings.dataDir || undefined);
    if (dir) await move(dir);
  };

  const saveDays = async () => {
    const value = Number(days);
    if (!Number.isFinite(value) || value < 1 || value === settings.claudeSessionRetentionDays) {
      setDays(String(settings.claudeSessionRetentionDays));
      return;
    }
    try {
      useApp.setState({ settings: await call('settings.update', { claudeSessionRetentionDays: value }) });
    } catch (error) {
      toast('error', errorMessage(error));
      useApp.setState({ settings: await call('settings.get') });
    }
  };

  return (
    <>
      <div className="section-title">
        <h2>Data storage</h2>
      </div>
      <div className="card settings-list">
        <Setting
          title="Data folder"
          description={
            settings.dataDir ? (
              <>
                <span className="mono">{settings.dataDir}</span> holds every account folder (one per account: transcripts, file history, settings) and the
                computer-use screenshots, each linked back from its usual place.
              </>
            ) : (
              <>
                Account folders stay where the tools keep them (<span className="mono">.claude</span>, <span className="mono">.codex</span>, Foreman's accounts
                folder) and computer-use screenshots in AppData, all on the system drive. Choose one folder (another drive, say) to keep them all there. Stop
                running agents first.
              </>
            )
          }
        >
          {settings.dataDir ? (
            <button className="btn ghost sm" onClick={() => call('shell.openPath', settings.dataDir)}>
              <FolderOpen size={14} /> Open
            </button>
          ) : null}
          {settings.dataDir ? (
            <button className="btn sm" disabled={moving} onClick={() => move('')}>
              Move back
            </button>
          ) : null}
          <button className="btn sm" disabled={moving} onClick={choose}>
            <FolderOpen size={13} /> {moving ? 'Moving…' : 'Choose…'}
          </button>
        </Setting>
        <Setting
          title="Keep Claude transcripts for"
          description="Claude Code deletes transcripts older than this when it starts, inside Foreman or not; deleted sessions can't be resumed. Saved as cleanupPeriodDays in each Claude account's settings.json. Codex sessions aren't affected."
        >
          <input
            className="input"
            type="number"
            min={1}
            max={36500}
            aria-label="Days to keep Claude transcripts"
            style={{ width: 90 }}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            onBlur={saveDays}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <span className="muted">days</span>
        </Setting>
      </div>
    </>
  );
}

/** Download and setup progress of the selected speech model; the download starts as soon as it is chosen. */
function VoiceModelStatus() {
  const status = useVoiceStatus();
  const text = describeVoiceStatus(status);
  if (!text) return null;
  const determinate = status.state === 'loading' && status.percent !== null && status.percent < 100;
  return (
    <div className="voice-model-status" role="status">
      {status.state === 'loading' ? (
        <div className={`progress ${determinate ? '' : 'indeterminate'}`} role="progressbar" aria-label="Speech model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate ? status.percent! : undefined}>
          <div style={{ width: determinate ? `${status.percent}%` : undefined }} />
        </div>
      ) : null}
      <span className={status.state === 'failed' ? 'voice-model-error' : 'muted'}>{text}</span>
      {status.state === 'failed' ? <button className="btn sm" onClick={() => prepareVoiceModel(undefined, true)}>Retry</button> : null}
    </div>
  );
}
