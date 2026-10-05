import { useEffect, useState } from 'react';
import { Download, FolderOpen, RefreshCw } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type AppSettings, type PricingStatus, type UpdateStatus } from '@shared/types';
import { call, errorMessage, listen } from '../api';
import { useApp } from '../store';
import { VOICE_MODELS, voiceModel } from '@shared/voiceModels';
import { describeVoiceStatus, prepareVoiceModel, useVoiceStatus } from '../voice/engine';
import { Segmented, Select, Switch } from '../ui';

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
        <Setting title="Launch isolated Codex accounts without the shared daemon" description="Passes --no-daemon so a second account never attaches to a background app-server started under another account.">
          <Switch on={settings.codexNoDaemonForIsolated} onChange={(v) => update({ codexNoDaemonForIsolated: v })} />
        </Setting>
        <Setting
          title="Capture Claude Code's status line"
          description="Claude sessions started here report their exact context size, cost and 5-hour/weekly plan usage to the app. Your own status-line command still runs and is shown as before."
        >
          <Switch on={settings.claudeStatusLine} onChange={(v) => update({ claudeStatusLine: v })} />
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
          description="New Claude Code and Codex agents get browser tools for a Chromium browser inside Foreman. It runs off-screen with its own cookies and logins, apart from your browsers, so it never takes your screen, mouse or keyboard. Watch it (and take over) with the Browser button beside an agent."
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
        <Setting title="Show the browser when an agent starts using it" description="Opens it beside the conversation; you can close it at any time.">
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
