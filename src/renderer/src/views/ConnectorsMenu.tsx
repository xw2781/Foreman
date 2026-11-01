// The chat composer's Connectors control: the claude.ai connectors (Microsoft 365,
// Gmail, Google Drive…) and MCP servers a Claude session can use, and sign-in
// for the ones that need it. A claude.ai connector is authorized on claude.ai
// itself: "Sign in" opens that page in the browser, then the session connects
// again ("I've signed in", or automatically when Foreman gets focus back).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, LoaderCircle, Plug, RefreshCw } from 'lucide-react';
import type { AgentInfo, ChatConnector } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';

const MANAGE_URL = 'https://claude.ai/settings/connectors';
/** Kept across composer remounts so the pill doesn't flicker when switching chats. */
const known = new Map<string, ChatConnector[]>();

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

export function ConnectorsMenu({ agent }: { agent: AgentInfo }) {
  const toast = useApp((s) => s.toast);
  const email = useApp((s) => s.profiles.find((p) => p.id === agent.profileId)?.emailHint);
  const [list, setList] = useState<ChatConnector[] | null>(() => known.get(agent.id) ?? null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Connectors whose sign-in page was opened: name → that page. */
  const [awaiting, setAwaiting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = useRef(agent.id);
  current.current = agent.id;

  const load = async () => {
    const id = agent.id;
    setLoading(true);
    try {
      const next = await call('chat.connectors', id);
      known.set(id, next);
      if (current.current === id) setList(next);
      return next;
    } catch {
      return null;
    } finally {
      if (current.current === id) setLoading(false);
    }
  };

  useEffect(() => {
    setList(known.get(agent.id) ?? null);
    setOpen(false);
    setAwaiting({});
    setErrors({});
    void load();
  }, [agent.id, agent.runId]);

  // claude.ai connectors come up a few seconds after the session starts (before that the list is
  // empty, or still connecting): look again until they settle, and whenever the agent changes state.
  const pending = list?.some((c) => c.status === 'pending') ?? false;
  const empty = !list?.length;
  const retries = useRef(0);
  useEffect(() => {
    retries.current = 0;
  }, [agent.id, agent.runId]);
  useEffect(() => {
    if (!pending && !(empty && retries.current < 12)) return;
    const timer = window.setTimeout(() => {
      retries.current += 1;
      void load();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [pending, empty, list]);
  useEffect(() => {
    if (agent.status === 'idle' || agent.status === 'needs-input') void load();
  }, [agent.status]);

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
      await load();
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

  const show = () => {
    setPlace({ visibility: 'hidden' });
    setOpen(true);
    void load();
  };
  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = menu.current.offsetWidth;
    setPlace({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - rect.top + 6,
      maxHeight: Math.max(160, rect.top - 16)
    });
  }, [open, list, awaiting, errors]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      trigger.current?.focus();
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (agent.provider !== 'claude' || agent.endedAt) return null;
  const connectors = list ?? [];
  const signInNeeded = connectors.filter((c) => c.status === 'needs-auth');
  const connected = connectors.filter((c) => c.status === 'connected').length;
  const label = signInNeeded.length === 1 ? `Sign in to ${signInNeeded[0].label}` : signInNeeded.length ? `${signInNeeded.length} need sign-in` : connected ? String(connected) : null;
  const tooltip = signInNeeded.length
    ? `${signInNeeded.map((c) => c.label).join(', ')} ${signInNeeded.length === 1 ? 'needs' : 'need'} sign-in before Claude can use ${signInNeeded.length === 1 ? 'it' : 'them'}`
    : connected
      ? `Connectors: ${connected} connected`
      : 'Connectors (Microsoft 365, Gmail, Google Drive…)';

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`connectors-pill ${signInNeeded.length ? 'attention' : ''} ${open ? 'on' : ''}`}
        title={tooltip}
        aria-label={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? close() : show())}
      >
        <Plug size={13} aria-hidden="true" />
        {label ? <span>{label}</span> : null}
      </button>
      {open
        ? createPortal(
            <div ref={menu} className="connectors-menu" role="dialog" aria-label="Connectors" style={place}>
              <div className="connectors-head">
                <span className="sel-heading">Connectors</span>
                <button type="button" className="btn ghost sm icon" title="Check again" aria-label="Check again" disabled={loading} onClick={() => void load()}>
                  <RefreshCw size={13} className={loading ? 'spin' : undefined} />
                </button>
              </div>
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
                <button
                  type="button"
                  className="connectors-link"
                  onClick={() => void call('shell.openExternal', MANAGE_URL).catch((error) => toast('error', errorMessage(error)))}
                >
                  Manage connectors on claude.ai <ExternalLink size={11} />
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
