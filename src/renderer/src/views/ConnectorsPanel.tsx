// The side panel's Connectors tab: the claude.ai connectors (Microsoft 365, Gmail,
// Google Drive…) and MCP servers a Claude chat session can use, and sign-in for
// the ones that need it. A claude.ai connector is authorized on claude.ai itself:
// "Sign in" opens that page in the browser, then the session connects again
// ("I've signed in", or automatically when Foreman gets focus back).
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, Plug, RefreshCw } from 'lucide-react';
import { create } from 'zustand';
import type { AgentInfo, ChatConnector } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { Empty } from '../ui';

const MANAGE_URL = 'https://claude.ai/settings/connectors';

const STATUS_TEXT: Record<ChatConnector['status'], string> = {
  connected: 'Connected',
  'needs-auth': 'Needs sign-in',
  pending: 'Connecting…',
  failed: 'Failed to connect',
  disabled: 'Turned off'
};

function friendly(error: string) {
  if (/needs-auth/.test(error)) return "Not signed in yet. Finish on the claude.ai page, then try again.";
  return error;
}

/** Only a running Claude chat can report its connectors. */
export function hasConnectors(agent: AgentInfo) {
  return agent.provider === 'claude' && agent.mode === 'chat';
}

/** Each session's last known connectors, kept across panel remounts so the tab badge and list don't flicker. */
const useConnectors = create<Record<string, { list: ChatConnector[] | null; loading: boolean }>>(() => ({}));

async function load(agentId: string) {
  useConnectors.setState((all) => ({ [agentId]: { list: all[agentId]?.list ?? null, loading: true } }));
  let list: ChatConnector[] | null = null;
  try {
    list = await call('chat.connectors', agentId);
  } catch {
    // Keep the last known list.
  }
  useConnectors.setState((all) => ({ [agentId]: { list: list ?? all[agentId]?.list ?? null, loading: false } }));
}

/** How many of the session's connectors wait for the person to sign in. */
export function useConnectorAlerts(agentId: string) {
  return useConnectors((s) => s[agentId]?.list?.filter((c) => c.status === 'needs-auth').length ?? 0);
}

/**
 * Keeps the session's connectors current while its side panel shows: claude.ai connectors come up a few
 * seconds after the session starts (before that the list is empty, or still connecting), so look again
 * until they settle, and whenever the agent changes state.
 */
export function useConnectorWatch(agent: AgentInfo) {
  const enabled = hasConnectors(agent) && !agent.endedAt;
  const list = useConnectors((s) => s[agent.id]?.list ?? null);
  const pending = list?.some((c) => c.status === 'pending') ?? false;
  const empty = !list?.length;
  const retries = useRef(0);
  useEffect(() => {
    retries.current = 0;
    if (enabled) void load(agent.id);
  }, [agent.id, agent.runId, enabled]);
  useEffect(() => {
    if (!enabled || (!pending && !(empty && retries.current < 12))) return;
    const timer = window.setTimeout(() => {
      retries.current += 1;
      void load(agent.id);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [enabled, pending, empty, list, agent.id]);
  useEffect(() => {
    if (enabled && (agent.status === 'idle' || agent.status === 'needs-input')) void load(agent.id);
  }, [agent.status]);
}

export function ConnectorsPane({ agent }: { agent: AgentInfo }) {
  const toast = useApp((s) => s.toast);
  const email = useApp((s) => s.profiles.find((p) => p.id === agent.profileId)?.emailHint);
  const { list, loading } = useConnectors((s) => s[agent.id]) ?? { list: null, loading: false };
  /** Connectors whose sign-in page was opened: name → that page. */
  const [awaiting, setAwaiting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setAwaiting({});
    setErrors({});
  }, [agent.id, agent.runId]);

  const reconnect = async (name: string, quiet = false) => {
    setBusy(name);
    try {
      const error = await call('chat.connectorReconnect', agent.id, name);
      if (error) {
        if (!quiet) setErrors((e) => ({ ...e, [name]: friendly(error) }));
      } else {
        setAwaiting(({ [name]: _, ...rest }) => rest);
        setErrors(({ [name]: _, ...rest }) => rest);
      }
    } catch (error) {
      if (!quiet) setErrors((e) => ({ ...e, [name]: errorMessage(error) }));
    } finally {
      setBusy(null);
      await load(agent.id);
    }
  };

  // Back from the browser: try the connectors that were being signed in to.
  useEffect(() => {
    const names = Object.keys(awaiting);
    if (!names.length) return;
    const back = () => names.forEach((name) => void reconnect(name, true));
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [awaiting, agent.id]);

  const signIn = async (connector: ChatConnector) => {
    setBusy(connector.name);
    setErrors(({ [connector.name]: _, ...rest }) => rest);
    try {
      const url = await call('chat.connectorSignIn', agent.id, connector.name);
      setAwaiting((a) => ({ ...a, [connector.name]: url }));
    } catch (error) {
      setErrors((e) => ({ ...e, [connector.name]: errorMessage(error) }));
    } finally {
      setBusy(null);
    }
  };

  const manage = () => void call('shell.openExternal', MANAGE_URL).catch((error) => toast('error', errorMessage(error)));

  if (agent.endedAt) {
    return (
      <div className="sp-pane">
        <Empty icon={<Plug size={22} />} title="Conversation ended">
          Connectors show while the chat is running. Resume it to see them.
        </Empty>
      </div>
    );
  }

  const connectors = list ?? [];
  const connected = connectors.filter((c) => c.status === 'connected').length;
  return (
    <div className="sp-pane connectors-pane" aria-label="Connectors">
      <div className="sp-bar">
        <span className="sp-bar-text">
          {list === null ? 'Checking…' : connectors.length ? `${connected} of ${connectors.length} connected` : 'No connectors'}
        </span>
        <button type="button" className="btn ghost sm icon" title="Check again" aria-label="Check again" disabled={loading} onClick={() => void load(agent.id)}>
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />
        </button>
      </div>
      <div className="connectors-body">
        {list === null ? (
          <div className="connectors-empty"><LoaderCircle size={14} className="spin" /> Checking this session's connectors…</div>
        ) : connectors.length === 0 ? (
          <div className="connectors-empty">
            This session has no connectors. Add Microsoft 365, Gmail and others on claude.ai, then start a new chat.
          </div>
        ) : (
          <ul className="connectors-list">
            {connectors.map((c) => {
              const page = awaiting[c.name];
              const working = busy === c.name;
              const detail = errors[c.name] ?? (page ? null : c.status === 'failed' && c.error ? c.error : null);
              return (
                <li key={c.name} className="connector-row" data-status={c.status}>
                  <span className={`connector-dot ${c.status}`} aria-hidden="true" />
                  <div className="connector-text">
                    <span className="connector-name">{c.label}</span>
                    <span className="connector-sub">
                      {page ? 'Waiting for you to finish in the browser' : STATUS_TEXT[c.status]}
                      {c.status === 'connected' && c.tools ? ` · ${c.tools} tools` : ''}
                      {c.source === 'local' ? ' · local' : ''}
                    </span>
                    {page ? (
                      <span className="connector-help">
                        Approve access on the claude.ai page{email ? ` (signed in as ${email})` : ''}, then come back here.{' '}
                        <button type="button" className="connectors-link" onClick={() => void call('shell.openExternal', page)}>Open the page again</button>
                      </span>
                    ) : null}
                    {detail ? <span className="connector-error" role="alert">{detail}</span> : null}
                  </div>
                  <div className="connector-action">
                    {working || c.status === 'pending' ? (
                      <LoaderCircle size={14} className="spin" aria-label="Working" />
                    ) : page ? (
                      <button type="button" className="btn primary sm" onClick={() => void reconnect(c.name)}>I've signed in</button>
                    ) : c.status === 'needs-auth' ? (
                      <button type="button" className="btn primary sm" onClick={() => void signIn(c)}>
                        Sign in <ExternalLink size={12} />
                      </button>
                    ) : c.status === 'failed' ? (
                      <button type="button" className="btn sm" onClick={() => void reconnect(c.name)}>Retry</button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="connectors-foot">
          <span>Sign-in is kept by your claude.ai account, so it carries over to new chats.</span>
          <button type="button" className="connectors-link" onClick={manage}>
            Manage connectors on claude.ai <ExternalLink size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
