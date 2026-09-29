import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Code2,
  Download,
  FolderOpen,
  Globe,
  Hand,
  History,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  X
} from 'lucide-react';
import type { AgentInfo, BrowserCommand, BrowserInput, BrowserState } from '@shared/types';
import { call, errorMessage, listen } from '../api';
import { useApp } from '../store';
import { ago } from '../format';
import { useTicker } from '../ui';

function sendInput(agentId: string, input: BrowserInput) {
  window.atc.send('browser.input', agentId, input);
}

function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const BUTTONS = ['left', 'middle', 'right'] as const;

/** Where the page's frame sits inside the canvas box (it keeps its aspect ratio). */
interface Fit {
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

function useFrames(agentId: string, canvas: React.RefObject<HTMLCanvasElement | null>, onSize: (width: number, height: number) => void) {
  useEffect(() => {
    call('browser.watch', agentId).catch(() => {});
    let decoding = false;
    let pending: { data: Uint8Array; width: number; height: number } | null = null;
    const draw = async () => {
      if (decoding || !pending) return;
      const frame = pending;
      pending = null;
      decoding = true;
      try {
        const bitmap = await createImageBitmap(new Blob([frame.data as BlobPart], { type: 'image/jpeg' }));
        const target = canvas.current;
        if (target) {
          if (target.width !== bitmap.width || target.height !== bitmap.height) {
            target.width = bitmap.width;
            target.height = bitmap.height;
            onSize(bitmap.width, bitmap.height);
          }
          target.getContext('2d')?.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      } catch {
        // a frame that doesn't decode is skipped
      } finally {
        decoding = false;
        if (pending) draw();
      }
    };
    const offFrame = listen('browser-frame', (frame) => {
      if (frame.agentId !== agentId) return;
      pending = frame;
      draw();
    });
    const offCursor = listen('browser-cursor', ({ agentId: id, cursor }) => {
      if (id === agentId && canvas.current) canvas.current.style.cursor = cursor;
    });
    return () => {
      offFrame();
      offCursor();
      call('browser.watch', null).catch(() => {});
    };
  }, [agentId]);
}

function Viewport({ agentId, state }: { agentId: string; state: BrowserState }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [fit, setFit] = useState<Fit | null>(null);
  useTicker(500);
  useFrames(agentId, canvas, (width, height) => setFrame({ width, height }));

  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !frame.width) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const scale = Math.min(width / frame.width, height / frame.height);
      setFit({ scale, left: (width - frame.width * scale) / 2, top: (height - frame.height * scale) / 2, width: frame.width * scale, height: frame.height * scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame.width, frame.height]);

  // Page pixels under a mouse event.
  const toPage = (event: { clientX: number; clientY: number }) => {
    const target = canvas.current;
    if (!target || !target.width) return null;
    const rect = target.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * target.width, y: ((event.clientY - rect.top) / rect.height) * target.height };
  };

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    let move: { x: number; y: number; button: 'left' | 'middle' | 'right' | 'none'; modifiers: number } | null = null;
    let frameRequest = 0;
    const flushMove = () => {
      frameRequest = 0;
      if (move) sendInput(agentId, { kind: 'mouse', type: 'mouseMoved', x: move.x, y: move.y, button: move.button, clickCount: 0, modifiers: move.modifiers });
      move = null;
    };
    const onMove = (event: MouseEvent) => {
      const point = toPage(event);
      if (!point) return;
      const button = event.buttons & 1 ? 'left' : event.buttons & 2 ? 'right' : event.buttons & 4 ? 'middle' : 'none';
      move = { ...point, button, modifiers: modifiers(event) };
      if (!frameRequest) frameRequest = requestAnimationFrame(flushMove);
    };
    const onButton = (event: MouseEvent) => {
      const point = toPage(event);
      if (!point) return;
      if (event.type === 'mousedown') target.focus();
      event.preventDefault();
      sendInput(agentId, {
        kind: 'mouse',
        type: event.type === 'mousedown' ? 'mousePressed' : 'mouseReleased',
        ...point,
        button: BUTTONS[event.button] ?? 'left',
        clickCount: Math.max(1, event.detail),
        modifiers: modifiers(event)
      });
    };
    const onWheel = (event: WheelEvent) => {
      const point = toPage(event);
      if (!point) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      sendInput(agentId, { kind: 'wheel', ...point, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: modifiers(event) });
    };
    const onKey = (event: KeyboardEvent) => {
      // App shortcuts (Ctrl+N, Ctrl+1…6, Ctrl+Tab) stay the app's.
      if (event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      const printable = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
      const text = event.type === 'keydown' ? (printable ? event.key : event.key === 'Enter' ? '\r' : '') : '';
      sendInput(agentId, { kind: 'key', type: event.type === 'keydown' ? 'keyDown' : 'keyUp', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event), text });
    };
    // Text from an input method (Chinese, Japanese…) arrives when composition ends.
    const onComposition = (event: CompositionEvent) => {
      if (event.data) sendInput(agentId, { kind: 'text', text: event.data });
    };
    const noMenu = (event: MouseEvent) => event.preventDefault();
    target.addEventListener('mousemove', onMove);
    target.addEventListener('mousedown', onButton);
    target.addEventListener('mouseup', onButton);
    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('keydown', onKey);
    target.addEventListener('keyup', onKey);
    target.addEventListener('compositionend', onComposition);
    target.addEventListener('contextmenu', noMenu);
    return () => {
      cancelAnimationFrame(frameRequest);
      target.removeEventListener('mousemove', onMove);
      target.removeEventListener('mousedown', onButton);
      target.removeEventListener('mouseup', onButton);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('keydown', onKey);
      target.removeEventListener('keyup', onKey);
      target.removeEventListener('compositionend', onComposition);
      target.removeEventListener('contextmenu', noMenu);
    };
  }, [agentId]);

  const pointer = state.pointer && Date.now() - state.pointer.at < 2500 && fit && frame.width ? state.pointer : null;
  return (
    <div className="bp-viewport" ref={box}>
      <canvas ref={canvas} className="bp-canvas" tabIndex={0} aria-label="Agent browser page" />
      {!frame.width ? <div className="bp-blank muted">Loading…</div> : null}
      {pointer && fit ? (
        <span
          key={pointer.at}
          className="bp-pointer"
          style={{ left: fit.left + pointer.x * fit.scale, top: fit.top + pointer.y * fit.scale }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

function AddressBar({ agentId, url }: { agentId: string; url: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const go = async () => {
    const target = draft?.trim();
    setDraft(null);
    if (!target) return;
    try {
      await call('browser.navigate', agentId, target);
    } catch (error) {
      useApp.getState().toast('error', errorMessage(error));
    }
  };
  return (
    <input
      className="input bp-url"
      spellCheck={false}
      value={draft ?? url}
      placeholder="Type a URL"
      onFocus={(e) => {
        setDraft(url);
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          go();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function ActivityLog({ state, onClose }: { state: BrowserState; onClose: () => void }) {
  useTicker(10_000);
  const items = [...state.actions].reverse();
  return (
    <div className="bp-popover" role="dialog" aria-label="Browser activity">
      <div className="bp-popover-head">
        <strong>Activity</strong>
        <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
          <X size={13} />
        </button>
      </div>
      {items.length ? (
        <ol className="bp-log">
          {items.map((a) => (
            <li key={a.id} className={a.ok ? '' : 'failed'}>
              {a.source === 'agent' ? <Bot size={12} /> : <Hand size={12} />}
              <span className="bp-log-text">{a.text}</span>
              <span className="muted">{ago(a.at)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="muted" style={{ padding: '6px 2px' }}>
          Nothing yet.
        </div>
      )}
      {state.downloads.length ? (
        <>
          <div className="bp-popover-head" style={{ marginTop: 8 }}>
            <strong>Downloads</strong>
          </div>
          <ol className="bp-log">
            {[...state.downloads].reverse().map((d) => (
              <li key={d.id}>
                <Download size={12} />
                <span className="bp-log-text" title={d.path}>
                  {d.name}
                </span>
                <span className="muted">{d.state === 'progressing' ? (d.totalBytes ? `${Math.round((d.receivedBytes / d.totalBytes) * 100)}%` : '…') : d.state === 'completed' ? '' : d.state}</span>
                {d.state === 'completed' ? (
                  <button className="btn ghost icon sm" title="Show in folder" onClick={() => call('shell.showItem', d.path)}>
                    <FolderOpen size={12} />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

function StatusBar({ agent, state }: { agent: AgentInfo; state: BrowserState }) {
  useTicker(5000);
  const [log, setLog] = useState(false);
  const last = state.actions[state.actions.length - 1];
  const command = (name: 'pause' | 'resume') => call('browser.command', agent.id, name).catch(() => {});
  return (
    <div className={`bp-status ${state.paused ? 'paused' : state.busy ? 'busy' : ''}`}>
      {state.paused ? (
        <>
          <Hand size={14} />
          <span className="bp-status-text">
            <strong>You have control.</strong> The agent's browser tools are paused.
          </span>
          <button className="btn sm primary" onClick={() => command('resume')}>
            Hand back to agent
          </button>
        </>
      ) : (
        <>
          {state.busy ? <Loader2 size={14} className="spin" /> : <Bot size={14} />}
          <span className="bp-status-text" title={last?.text}>
            {last ? (
              <>
                {last.source === 'user' ? 'You: ' : ''}
                {last.text}
                <span className="muted"> · {ago(last.at)}</span>
              </>
            ) : (
              <span className="muted">The agent hasn't used the browser yet.</span>
            )}
          </span>
          <button className="btn sm" title="Pause the agent's browser tools while you use the page" onClick={() => command('pause')}>
            <Hand size={13} /> Take control
          </button>
        </>
      )}
      <button className={`btn ghost icon sm ${log ? 'on' : ''}`} title="Activity and downloads" onClick={() => setLog(!log)}>
        <History size={14} />
        {state.downloads.some((d) => d.state === 'progressing') ? <span className="bp-dot" /> : null}
      </button>
      {log ? <ActivityLog state={state} onClose={() => setLog(false)} /> : null}
    </div>
  );
}

export function BrowserPanel({ agent, state, expanded, onExpand }: { agent: AgentInfo; state: BrowserState | null; expanded: boolean; onExpand?: () => void }) {
  const hide = () => useApp.setState({ browserShown: { ...useApp.getState().browserShown, [agent.id]: false }, browserExpanded: false });
  const command = (name: BrowserCommand, tabId?: string) => call('browser.command', agent.id, name, tabId).catch((error) => useApp.getState().toast('error', errorMessage(error)));

  useEffect(() => {
    // Opening the panel before the agent browses gives it a blank tab, e.g. to sign in to a site first.
    if (!state) call('browser.open', agent.id).catch((error) => useApp.getState().toast('error', errorMessage(error)));
  }, [agent.id, Boolean(state)]);

  const active = state?.tabs.find((t) => t.id === state.activeTabId) ?? null;
  return (
    <section className="browser-panel" aria-label="Agent browser">
      <div className="bp-tabs">
        {state?.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`bp-tab ${tab.id === state.activeTabId ? 'on' : ''}`}
            title={`${tab.title || tab.url}\n${tab.url}`}
            onClick={() => tab.id !== state.activeTabId && command('selectTab', tab.id)}
          >
            {tab.loading ? <Loader2 size={12} className="spin" /> : <Globe size={12} />}
            <span className="ellipsis">{tab.title || tab.url || 'New tab'}</span>
            <button
              className="bp-tab-close"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                command('closeTab', tab.id);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="btn ghost icon sm" title="New tab" onClick={() => command('newTab')}>
          <Plus size={14} />
        </button>
        <div className="bp-tabs-end">
          {onExpand ? (
            <button className="btn ghost icon sm" title={expanded ? 'Show the conversation too' : 'Fill the panel with the browser'} onClick={onExpand}>
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          ) : null}
          <button className="btn ghost icon sm" title="Hide the browser (it keeps running for the agent)" onClick={hide}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="bp-toolbar">
        <button className="btn ghost icon sm" title="Back" disabled={!active?.canGoBack} onClick={() => command('back')}>
          <ArrowLeft size={15} />
        </button>
        <button className="btn ghost icon sm" title="Forward" disabled={!active?.canGoForward} onClick={() => command('forward')}>
          <ArrowRight size={15} />
        </button>
        <button className="btn ghost icon sm" title={active?.loading ? 'Stop' : 'Reload'} disabled={!active} onClick={() => command(active?.loading ? 'stop' : 'reload')}>
          {active?.loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>
        <AddressBar agentId={agent.id} url={active?.url && active.url !== 'about:blank' ? active.url : ''} />
        <button className="btn ghost icon sm" title="Open DevTools for this page" disabled={!active} onClick={() => command('devtools')}>
          <Code2 size={15} />
        </button>
      </div>
      {state?.fileChooser ? <div className="bp-notice">The page is waiting for the agent to choose files to upload.</div> : null}
      {state && active ? (
        <Viewport key={agent.id} agentId={agent.id} state={state} />
      ) : (
        <div className="bp-viewport bp-empty">
          <Globe size={22} className="muted" />
          <div className="muted">{state ? 'No page is open. Type a URL above, or let the agent open one.' : 'Opening the browser…'}</div>
        </div>
      )}
      {state ? <StatusBar agent={agent} state={state} /> : null}
    </section>
  );
}
