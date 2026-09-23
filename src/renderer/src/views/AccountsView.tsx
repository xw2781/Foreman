import { useState } from 'react';
import { CheckCircle2, FolderOpen, Globe2, KeyRound, LogIn, LogOut, MoreHorizontal, Pencil, Plus, RefreshCw, Share2, SquareTerminal, Trash2, UserPlus } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type ProfileView, type Provider } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { ago, colorVar, initials } from '../format';
import { LimitMeters, Modal, ProviderIcon, Switch, confirmDialog } from '../ui';

const SLOTS = ['slot-3', 'slot-4', 'slot-5', 'slot-6', 'slot-7', 'slot-8'];

async function run<T>(action: () => Promise<T>, success?: string): Promise<T | null> {
  try {
    const result = await action();
    if (success) useApp.getState().toast('success', success);
    return result;
  } catch (error) {
    useApp.getState().toast('error', errorMessage(error));
    return null;
  }
}

function setProfiles(profiles: ProfileView[] | null) {
  if (profiles) useApp.setState({ profiles });
}

function AddAccountDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    const profiles = await run(() => call('profiles.create', { provider, label: label.trim() || 'Secondary', emailHint: email.trim() || undefined, shareConfig: share }));
    setBusy(false);
    if (!profiles) return;
    setProfiles(profiles);
    onClose();
    const created = profiles.filter((p) => p.provider === provider && !p.builtin).slice(-1)[0];
    if (created) {
      const agent = await run(() => call('profiles.login', created.id));
      if (agent) useApp.setState({ selectedAgentId: agent.id, view: 'agents' });
    }
  };
  return (
    <Modal
      title={`Add a ${PROVIDER_LABEL[provider]} account`}
      icon={<UserPlus size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy}>
            <LogIn size={14} /> Create and sign in
          </button>
        </>
      }
    >
      <p className="secondary" style={{ margin: 0, lineHeight: 1.6 }}>
        The account gets its own {provider === 'claude' ? 'Claude config folder (CLAUDE_CONFIG_DIR)' : 'Codex home (CODEX_HOME)'}, so its sign-in, history and usage stay separate and both accounts can run at the same time. A sign-in terminal opens next; your browser will ask which account to authorize, so pick the second one there.
      </p>
      <div className="grid-2">
        <div className="field">
          <label>Name</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work, Personal…" autoFocus />
        </div>
        <div className="field">
          <label>Email (optional)</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={provider === 'claude' ? 'Pre-fills the sign-in page' : 'For your reference'} />
        </div>
      </div>
      <label className="row" style={{ alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
        <Switch on={share} onChange={setShare} />
        <span>
          <div style={{ fontWeight: 500 }}>Share settings with the primary account</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {provider === 'claude'
              ? 'Copies settings.json and CLAUDE.md, and links skills, agents and commands, so both accounts behave the same.'
              : 'Copies config.toml and AGENTS.md, and links skills, prompts and rules, so both accounts behave the same.'}
          </div>
        </span>
      </label>
    </Modal>
  );
}

function EditAccountDialog({ profile, onClose }: { profile: ProfileView; onClose: () => void }) {
  const [label, setLabel] = useState(profile.label);
  const [color, setColor] = useState(profile.color);
  const save = async () => {
    setProfiles(await run(() => call('profiles.update', profile.id, { label, color })));
    onClose();
  };
  return (
    <Modal
      title="Edit account"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Color</label>
        <div className="row">
          {SLOTS.map((slot) => (
            <button
              key={slot}
              onClick={() => setColor(slot)}
              title={slot}
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                background: colorVar(slot),
                border: color === slot ? '2px solid var(--text-primary)' : '2px solid transparent',
                cursor: 'pointer'
              }}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}

function AccountCard({ profile }: { profile: ProfileView }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const identity = profile.identity;
  const signedIn = Boolean(identity?.loggedIn);

  const login = async () => {
    const agent = await run(() => call('profiles.login', profile.id));
    if (agent) useApp.setState({ selectedAgentId: agent.id, view: 'agents' });
  };
  const logout = async () => {
    const { ok } = await confirmDialog({
      title: `Sign out of "${profile.label}"?`,
      message: `This runs the ${PROVIDER_LABEL[profile.provider]} sign-out for this account's folder only. Other accounts stay signed in.`,
      confirmLabel: 'Sign out',
      danger: true
    });
    if (ok) setProfiles(await run(() => call('profiles.logout', profile.id), 'Signed out.'));
  };
  const makeGlobal = async () => {
    const { ok } = await confirmDialog({
      title: `Use "${profile.label}" everywhere?`,
      message: (
        <>
          Sets your user environment variable <span className="mono">{profile.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}</span>
          {profile.builtin ? ' back to the default (removes it)' : ` to this account's folder`} so VS Code, the desktop apps, and new terminals use this account after they restart. Agents in this app are unaffected — they always use the account you pick.
        </>
      ),
      confirmLabel: 'Make default'
    });
    if (ok) setProfiles(await run(() => call('profiles.setGlobalDefault', profile.id)));
  };
  const remove = async () => {
    const { ok, checked } = await confirmDialog({
      title: `Remove "${profile.label}"?`,
      message: 'The account is removed from this app.',
      checkbox: `Also delete its folder (${profile.configDir}), including its sign-in and history`,
      confirmLabel: 'Remove',
      danger: true
    });
    if (ok) setProfiles(await run(() => call('profiles.remove', profile.id, checked)));
  };
  const openShell = async () => {
    const agent = await run(() => call('profiles.openShell', profile.id));
    if (agent) useApp.setState({ selectedAgentId: agent.id, view: 'agents' });
  };

  return (
    <div className={`account-card ${profile.isActive ? 'active' : ''}`}>
      <div className="ac-head">
        <div className="avatar" style={{ background: colorVar(profile.color) }}>
          {initials(identity?.name ?? profile.label)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ac-name">
            <span className="ellipsis">{profile.label}</span>
            {identity?.plan ? <span className="badge accent">{identity.plan}</span> : null}
          </div>
          <div className="ac-email ellipsis">
            {signedIn ? identity?.email ?? identity?.authMethod ?? 'Signed in' : <span style={{ color: 'var(--serious)' }}>Not signed in</span>}
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn ghost icon" onClick={() => setMenu(!menu)} aria-label="More">
            <MoreHorizontal size={16} />
          </button>
          {menu ? (
            <div className="popover" style={{ left: 'auto', right: 0, width: 240 }} onMouseLeave={() => setMenu(false)}>
              <button className="pop-item" onClick={() => { setMenu(false); setEditing(true); }}>
                <Pencil size={14} /> <span>Rename or recolor</span> <span />
              </button>
              <button className="pop-item" onClick={() => { setMenu(false); call('shell.openPath', profile.configDir); }}>
                <FolderOpen size={14} /> <span>Open config folder</span> <span />
              </button>
              {!profile.builtin ? (
                <button className="pop-item" onClick={async () => { setMenu(false); setProfiles(await run(() => call('profiles.shareConfig', profile.id), 'Settings copied from the primary account.')); }}>
                  <Share2 size={14} /> <span>Re-copy shared settings</span> <span />
                </button>
              ) : null}
              {signedIn ? (
                <button className="pop-item" onClick={() => { setMenu(false); logout(); }}>
                  <LogOut size={14} /> <span>Sign out</span> <span />
                </button>
              ) : null}
              {!profile.builtin ? (
                <button className="pop-item" onClick={() => { setMenu(false); remove(); }}>
                  <Trash2 size={14} color="var(--critical)" /> <span>Remove account</span> <span />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="ac-badges">
        {profile.isActive ? (
          <span className="badge accent">
            <CheckCircle2 size={11} /> Used for new agents
          </span>
        ) : null}
        {profile.isGlobalDefault ? (
          <span className="badge">
            <Globe2 size={11} /> Default for other apps
          </span>
        ) : null}
        {profile.runningAgents ? <span className="badge good">{profile.runningAgents} running</span> : null}
        {profile.skillInstalled ? <span className="badge">Computer use</span> : null}
        {profile.builtin ? <span className="badge">Default folder</span> : null}
      </div>

      <div className="ac-limits">
        <LimitMeters windows={profile.limits?.windows} />
      </div>
      {profile.limits?.observedAt ? (
        <div className="muted" style={{ fontSize: 11, marginTop: -6 }}>
          Plan usage as last reported by {PROVIDER_LABEL[profile.provider]} {ago(profile.limits.observedAt)}
        </div>
      ) : null}

      <div className="ac-actions">
        {!profile.isActive ? (
          <button className="btn primary sm" onClick={async () => setProfiles(await run(() => call('profiles.setActive', profile.provider, profile.id), `New ${PROVIDER_LABEL[profile.provider]} agents will use "${profile.label}".`))}>
            <CheckCircle2 size={13} /> Use for new agents
          </button>
        ) : null}
        {signedIn ? null : (
          <button className="btn primary sm" onClick={login}>
            <LogIn size={13} /> Sign in
          </button>
        )}
        {!profile.isGlobalDefault ? (
          <button className="btn sm" onClick={makeGlobal} title="Set the user environment so other apps use this account">
            <Globe2 size={13} /> Make default for other apps
          </button>
        ) : null}
        <button className="btn sm" onClick={openShell} title="A PowerShell terminal whose environment points at this account">
          <SquareTerminal size={13} /> Terminal as this account
        </button>
        <button
          className="btn sm"
          onClick={() => useApp.getState().openLauncher({ provider: profile.provider, profileId: profile.id })}
          disabled={!signedIn}
        >
          <Plus size={13} /> New agent
        </button>
      </div>
      <div className="ac-path" title={profile.configDir}>
        {profile.configDir}
      </div>
      {editing ? <EditAccountDialog profile={profile} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

export function AccountsView() {
  const profiles = useApp((s) => s.profiles);
  const [adding, setAdding] = useState<Provider | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    setProfiles(await run(() => call('profiles.refresh')));
    setRefreshing(false);
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Accounts</h1>
          <p>Switch between accounts per tool. Each account keeps its own sign-in and history, and accounts can run side by side.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>
      <div className="account-columns">
        {PROVIDERS.map((provider) => (
          <div className="provider-column" key={provider}>
            <div className="provider-column-head">
              <ProviderIcon provider={provider} size={26} />
              <h2>{PROVIDER_LABEL[provider]}</h2>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setAdding(provider)}>
                <UserPlus size={13} /> Add account
              </button>
            </div>
            {profiles
              .filter((p) => p.provider === provider)
              .map((p) => (
                <AccountCard key={p.id} profile={p} />
              ))}
          </div>
        ))}
      </div>
      <div className="card card-pad section" style={{ display: 'grid', gap: 8 }}>
        <div className="row" style={{ fontWeight: 600 }}>
          <KeyRound size={15} className="muted" /> How switching works
        </div>
        <div className="secondary" style={{ lineHeight: 1.65, fontSize: 12.5 }}>
          <b>Used for new agents</b> picks the account the next agent in this app starts with (also in the title bar). Running agents keep their account. <b>Make default for other apps</b> points VS Code, the desktop apps and new terminals at an account by setting your user-level
          <span className="mono"> CLAUDE_CONFIG_DIR</span> / <span className="mono">CODEX_HOME</span>; those apps pick it up when they restart. Credentials are never copied between accounts: each one lives only in its own folder. Plan usage (5-hour and weekly windows) is what the CLI last reported, so it refreshes whenever that account runs a session.
        </div>
      </div>
      {adding ? <AddAccountDialog provider={adding} onClose={() => setAdding(null)} /> : null}
    </div>
  );
}
