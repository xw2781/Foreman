import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  Image,
  Info,
  ListChecks,
  LoaderCircle,
  Plug,
  Search,
  ShieldAlert,
  Square,
  Terminal,
  TriangleAlert,
  Wrench
} from 'lucide-react';
import { LIVE_STATUSES, PROVIDER_LABEL, type AgentInfo, type ChatFileChange, type ChatItem, type ChatQuestion } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { drafts, loadChat, useChats } from '../chats';
import { CopyButton, Markdown } from '../markdown';
import { compact, folderName, percent, usd } from '../format';
import { ProviderIcon } from '../ui';
import { MODELS, PERMISSIONS } from './LaunchDialog';
import '../chat.css';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

// ------------------------------------------------------------------ helpers

function seconds(ms: number | null) {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function toolIcon(item: Item<'tool'>) {
  const t = item.tool.toLowerCase();
  const size = 14;
  if (t === 'bash' || t === 'powershell' || t === 'shell') {
    if (item.title === 'Read') return <FileText size={size} />;
    if (item.title === 'Searched') return <Search size={size} />;
    if (item.title === 'Listed files') return <FolderSearch size={size} />;
    return <Terminal size={size} />;
  }
  if (t === 'read') return <FileText size={size} />;
  if (t === 'write') return <FilePlus size={size} />;
  if (t === 'edit' || t === 'multiedit' || t === 'notebookedit' || t === 'apply_patch') return item.title === 'Created' ? <FilePlus size={size} /> : <FilePen size={size} />;
  if (t === 'grep') return <Search size={size} />;
  if (t === 'glob') return <FolderSearch size={size} />;
  if (t === 'webfetch' || t === 'websearch' || t === 'web_search') return <Globe size={size} />;
  if (t === 'task' || t === 'agent') return <Bot size={size} />;
  if (t === 'todowrite') return <ListChecks size={size} />;
  if (t === 'view_image') return <Image size={size} />;
  if (t.startsWith('mcp__') || t.includes('.')) return <Plug size={size} />;
  return <Wrench size={size} />;
}

function diffStats(files: ChatFileChange[]) {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const line of file.diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }
  }
  return { added, removed };
}

// ------------------------------------------------------------------ pieces

function DiffFile({ file, defaultOpen }: { file: ChatFileChange; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const lines = useMemo(() => file.diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('diff --git') && !l.startsWith('index ')), [file.diff]);
  const { added, removed } = diffStats([file]);
  const shown = all ? lines : lines.slice(0, 80);
  const name = file.path.split(/[\\/]/).pop();
  return (
    <div className="diff-file">
      <button type="button" className="diff-head" onClick={() => setOpen(!open)} title={file.path}>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
        <span className="diff-name">{name}</span>
        <span className="diff-path ellipsis">{file.path}</span>
        {file.kind !== 'update' ? <span className={`badge ${file.kind === 'add' ? 'good' : 'critical'}`}>{file.kind === 'add' ? 'new' : 'deleted'}</span> : null}
        <span className="diff-count">
          {added ? <span className="plus">+{added}</span> : null} {removed ? <span className="minus">−{removed}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="diff-body selectable">
          {shown.map((line, index) => {
            const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
            return (
              <div key={index} className={`diff-line ${kind}`}>
                {kind === 'hunk' ? line : line.slice(1) || ' '}
              </div>
            );
          })}
          {lines.length > shown.length ? (
            <button type="button" className="diff-more" onClick={() => setAll(true)}>
              Show {lines.length - shown.length} more lines
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DiffView({ files, open }: { files: ChatFileChange[]; open?: boolean }) {
  return (
    <div className="diff">
      {files.map((file) => (
        <DiffFile key={file.path} file={file} defaultOpen={open ?? files.length === 1} />
      ))}
    </div>
  );
}

function Output({ text, label }: { text: string; label: string }) {
  return (
    <div className="tool-block">
      <div className="tool-block-head">
        <span>{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className="selectable">{text}</pre>
    </div>
  );
}

/** Titles are written for finished steps; one still running reads in the present. */
const IN_PROGRESS: Record<string, string> = {
  Ran: 'Running',
  Read: 'Reading',
  Wrote: 'Writing',
  Edited: 'Editing',
  Created: 'Creating',
  Searched: 'Searching',
  'Listed files': 'Listing files',
  Fetched: 'Fetching',
  'Searched the web': 'Searching the web',
  'Ran agent': 'Running agent',
  'Updated plan': 'Updating plan',
  'Used skill': 'Using skill',
  'Loaded tools': 'Loading tools'
};

const ToolRow = memo(function ToolRow({ item }: { item: Item<'tool'> }) {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(item.input || item.output || item.files?.length);
  const stats = item.files?.length ? diffStats(item.files) : null;
  const inputIsDetail = item.input && item.input === item.detail;
  return (
    <div className={`tool-row ${item.status} ${open ? 'open' : ''}`}>
      <button type="button" className="tool-line" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
        <span className="tool-icon">{toolIcon(item)}</span>
        <span className="tool-title">{item.status === 'running' ? IN_PROGRESS[item.title] ?? item.title : item.title}</span>
        {item.detail ? <span className={`tool-detail ellipsis ${item.tool.match(/bash|powershell|shell/i) ? 'mono' : ''}`}>{item.detail}</span> : null}
        {stats ? (
          <span className="diff-count">
            {stats.added ? <span className="plus">+{stats.added}</span> : null} {stats.removed ? <span className="minus">−{stats.removed}</span> : null}
          </span>
        ) : null}
        <span className="tool-state">
          {item.status === 'running' ? (
            <LoaderCircle size={13} className="spin" />
          ) : item.status === 'error' ? (
            <CircleX size={13} color="var(--critical)" />
          ) : item.status === 'declined' ? (
            <Ban size={13} color="var(--text-muted)" />
          ) : item.durationMs && item.durationMs >= 1000 ? (
            <span className="muted">{seconds(item.durationMs)}</span>
          ) : null}
        </span>
        {hasBody ? <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} /> : null}
      </button>
      {open ? (
        <div className="tool-body">
          {item.input && !(inputIsDetail && !item.input.includes('\n') && item.input.length < 120) ? <Output label={item.tool.match(/bash|powershell|shell/i) ? 'Command' : 'Input'} text={item.input} /> : null}
          {item.files?.length ? <DiffView files={item.files} open /> : null}
          {item.output ? <Output label={item.status === 'error' ? 'Error' : 'Output'} text={item.output} /> : null}
        </div>
      ) : null}
    </div>
  );
});

/** Consecutive tool calls; long finished runs fold into one line. */
function ToolGroup({ items, active }: { items: Array<Item<'tool'>>; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const foldable = items.length > 3 && !active && items.every((i) => i.status !== 'running');
  if (foldable && !expanded) {
    const failed = items.filter((i) => i.status === 'error').length;
    const edits = items.filter((i) => i.files?.length).length;
    return (
      <div className="tool-group">
        <button type="button" className="tool-line folded" onClick={() => setExpanded(true)}>
          <span className="tool-icon">
            <Wrench size={14} />
          </span>
          <span className="tool-title">{items.length} steps</span>
          <span className="tool-detail ellipsis">
            {[edits ? `${edits} edit${edits === 1 ? '' : 's'}` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ') || items.map((i) => i.title).filter((t, index, all) => all.indexOf(t) === index).slice(0, 4).join(', ')}
          </span>
          <ChevronRight size={13} className="chev" />
        </button>
      </div>
    );
  }
  return (
    <div className="tool-group">
      {items.map((item) => (
        <ToolRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function Reasoning({ item }: { item: Item<'reasoning'> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`reasoning ${open ? 'open' : ''}`}>
      <button type="button" className="reasoning-head" onClick={() => setOpen(!open)}>
        <Brain size={13} />
        <span>{item.streaming ? 'Thinking…' : 'Thought'}</span>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open ? <div className="reasoning-body selectable">{item.text}</div> : null}
    </div>
  );
}

function Questions({ questions, values, onChange }: { questions: ChatQuestion[]; values: Record<string, string[]>; onChange: (next: Record<string, string[]>) => void }) {
  const [other, setOther] = useState<Record<string, string>>({});
  return (
    <div className="questions">
      {questions.map((q) => {
        const chosen = values[q.id] ?? [];
        const toggle = (label: string) => {
          const next = q.multiSelect ? (chosen.includes(label) ? chosen.filter((c) => c !== label) : [...chosen, label]) : [label];
          onChange({ ...values, [q.id]: next });
        };
        return (
          <div key={q.id} className="question">
            {q.header ? <div className="q-header">{q.header}</div> : null}
            <div className="q-text">{q.question}</div>
            <div className="q-options">
              {q.options.map((option) => (
                <button type="button" key={option.label} className={`q-option ${chosen.includes(option.label) ? 'on' : ''}`} onClick={() => toggle(option.label)}>
                  <span className={`q-mark ${q.multiSelect ? 'box' : 'radio'}`}>{chosen.includes(option.label) ? <Check size={11} /> : null}</span>
                  <span>
                    <span className="q-label">{option.label}</span>
                    {option.description ? <span className="q-desc">{option.description}</span> : null}
                  </span>
                </button>
              ))}
              {q.allowOther ? (
                <input
                  className="input"
                  placeholder={q.options.length ? 'Other…' : 'Your answer'}
                  value={other[q.id] ?? ''}
                  onChange={(event) => {
                    const text = event.target.value;
                    setOther({ ...other, [q.id]: text });
                    const kept = chosen.filter((c) => q.options.some((o) => o.label === c));
                    onChange({ ...values, [q.id]: text.trim() ? (q.multiSelect ? [...kept, text.trim()] : [text.trim()]) : kept });
                  }}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ApprovalCard({ item, agent }: { item: Item<'approval'>; agent: AgentInfo }) {
  const toast = useApp((s) => s.toast);
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  if (item.state !== 'pending') {
    const denied = /^(Denied|Declined|Skipped|Kept planning)/.test(item.resolution ?? '');
    return (
      <div className={`approval-done ${item.state}`}>
        {item.state === 'cancelled' ? <Ban size={13} /> : denied ? <CircleX size={13} /> : <CircleCheck size={13} />}
        <span className="ellipsis">
          <span className="secondary">{item.title}</span> {item.resolution ? <>· {item.resolution}</> : null}
        </span>
      </div>
    );
  }
  const answer = async (optionId: string) => {
    setBusy(true);
    try {
      const joined = Object.fromEntries(Object.entries(answers).map(([id, list]) => [id, list.join(', ')]));
      await call('chat.respond', agent.id, item.id, { optionId, message: optionId === 'deny' || optionId === 'cancel' ? note.trim() || undefined : undefined, answers: joined });
    } catch (error) {
      toast('error', errorMessage(error));
      setBusy(false);
    }
  };
  const unanswered = item.questions?.some((q) => !(answers[q.id]?.length));
  return (
    <div className="approval">
      <div className="approval-head">
        <ShieldAlert size={16} color="var(--warning)" />
        <span>{item.title}</span>
      </div>
      {item.detail ? <div className="approval-detail">{item.detail}</div> : null}
      {item.body ? (
        item.bodyKind === 'markdown' ? (
          <div className="approval-plan">
            <Markdown text={item.body} />
          </div>
        ) : (
          <pre className={`approval-body selectable ${item.bodyKind === 'command' ? 'command' : ''}`}>{item.body}</pre>
        )
      ) : null}
      {item.files?.length ? <DiffView files={item.files} /> : null}
      {item.questions?.length ? <Questions questions={item.questions} values={answers} onChange={setAnswers} /> : null}
      <div className="approval-actions">
        {item.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`btn sm ${option.tone === 'primary' ? 'primary' : option.tone === 'danger' ? 'danger' : ''}`}
            disabled={busy || (option.id === 'answer' && unanswered)}
            onClick={() => answer(option.id)}
          >
            {option.label}
          </button>
        ))}
        {item.acceptsFeedback ? (
          <input
            className="input approval-note"
            placeholder={`Or tell ${PROVIDER_LABEL[agent.provider]} what to do instead…`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && note.trim()) answer('deny');
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function TurnFooter({ item }: { item: Item<'turn'> }) {
  const parts = [item.durationMs !== null ? `Worked for ${seconds(item.durationMs)}` : '', item.costUsd ? usd(item.costUsd, true) : ''].filter(Boolean);
  if (item.ok && !item.text && parts.length === 0) return null;
  return (
    <div className={`turn-footer ${item.ok ? '' : 'failed'}`}>
      <span className="rule" />
      <span>{[item.text, ...parts].filter(Boolean).join(' · ')}</span>
      <span className="rule" />
    </div>
  );
}

function Notice({ item }: { item: Item<'notice'> }) {
  return (
    <div className={`chat-notice ${item.tone}`}>
      {item.tone === 'error' ? <CircleX size={14} /> : item.tone === 'warning' ? <TriangleAlert size={14} /> : <Info size={14} />}
      <span className="selectable">{item.text}</span>
    </div>
  );
}

type Block = { key: string; node: ReactNode };

function buildBlocks(items: ChatItem[], agent: AgentInfo, working: boolean): Block[] {
  const blocks: Block[] = [];
  let tools: Array<Item<'tool'>> = [];
  const flush = (last: boolean) => {
    if (!tools.length) return;
    const group = tools;
    tools = [];
    blocks.push({ key: `g-${group[0].id}`, node: <ToolGroup items={group} active={last && working} /> });
  };
  items.forEach((item, index) => {
    if (item.kind === 'tool') {
      tools.push(item);
      if (index === items.length - 1) flush(true);
      return;
    }
    flush(false);
    switch (item.kind) {
      case 'user':
        blocks.push({
          key: item.id,
          node: (
            <div className="msg-user">
              <div className="bubble selectable">{item.text}</div>
            </div>
          )
        });
        break;
      case 'assistant':
        blocks.push({
          key: item.id,
          node: (
            <div className={`msg-assistant ${item.streaming ? 'streaming' : ''}`}>
              <Markdown text={item.text} />
            </div>
          )
        });
        break;
      case 'reasoning':
        blocks.push({ key: item.id, node: <Reasoning item={item} /> });
        break;
      case 'approval':
        blocks.push({ key: item.id, node: <ApprovalCard item={item} agent={agent} /> });
        break;
      case 'notice':
        blocks.push({ key: item.id, node: <Notice item={item} /> });
        break;
      case 'turn':
        blocks.push({ key: item.id, node: <TurnFooter item={item} /> });
        break;
      default:
        break;
    }
  });
  return blocks;
}

// ----------------------------------------------------------------- composer

function Composer({ agent }: { agent: AgentInfo }) {
  const toast = useApp((s) => s.toast);
  const [text, setText] = useState(() => drafts.get(agent.id) ?? '');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const live = !agent.endedAt;
  const working = live && (agent.status === 'working' || agent.status === 'starting');
  const t = agent.telemetry;

  useEffect(() => {
    setText(drafts.get(agent.id) ?? '');
    ref.current?.focus();
  }, [agent.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    if (value) drafts.set(agent.id, value);
    else drafts.delete(agent.id);
  };

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    update('');
    try {
      await call('chat.send', agent.id, message);
    } catch (error) {
      update(message);
      toast('error', errorMessage(error));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const configure = (patch: { permission?: string; model?: string }) => call('chat.configure', agent.id, patch).catch((error) => toast('error', errorMessage(error)));
  const models = MODELS[agent.provider];
  const currentModel = agent.model ?? '';

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={live ? (working ? `Message ${PROVIDER_LABEL[agent.provider]} (it's working; this is queued)` : `Message ${PROVIDER_LABEL[agent.provider]}…`) : 'Send a message to continue this conversation'}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === 'Escape' && working) call('chat.interrupt', agent.id);
          }}
        />
        <div className="composer-bar">
          <select className="composer-select" value={agent.permission ?? 'default'} title="Permissions" onChange={(e) => configure({ permission: e.target.value })}>
            {PERMISSIONS[agent.provider].map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <select className="composer-select" value={currentModel} title="Model" onChange={(e) => configure({ model: e.target.value })}>
            <option value="">Default model</option>
            {currentModel && !models.includes(currentModel) ? <option value={currentModel}>{currentModel}</option> : null}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="spacer" />
          {t && t.contextPercent !== null ? (
            <span className="composer-context" title={`${compact(t.contextUsedTokens)} of ${compact(t.contextWindow)} tokens in context`}>
              <svg width="16" height="16" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6" fill="none" stroke="var(--surface-3)" strokeWidth="2.5" />
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke={t.contextPercent >= 90 ? 'var(--critical)' : t.contextPercent >= 75 ? 'var(--warning)' : 'var(--accent)'}
                  strokeWidth="2.5"
                  strokeDasharray={`${(Math.min(100, t.contextPercent) / 100) * 37.7} 37.7`}
                  transform="rotate(-90 8 8)"
                  strokeLinecap="round"
                />
              </svg>
              {percent(t.contextPercent)}
            </span>
          ) : null}
          {working && !text.trim() ? (
            <button type="button" className="send-btn stop" title="Stop (Esc)" onClick={() => call('chat.interrupt', agent.id)}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-btn" title="Send (Enter)" disabled={!text.trim() || sending} onClick={send}>
              {sending ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <span>
          <span className="kbd">Enter</span> send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> new line{working ? <> · <span className="kbd">Esc</span> stop</> : null}
        </span>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- view

function Welcome({ agent }: { agent: AgentInfo }) {
  return (
    <div className="chat-welcome">
      <ProviderIcon provider={agent.provider} size={40} />
      <h2>What should we work on?</h2>
      <p className="secondary">
        {PROVIDER_LABEL[agent.provider]} · {agent.profileLabel} · <span className="mono">{folderName(agent.cwd)}</span>
      </p>
    </div>
  );
}

export function ChatView({ agent }: { agent: AgentInfo }) {
  const chat = useChats((s) => s.chats[agent.id]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const live = !agent.endedAt && LIVE_STATUSES.includes(agent.status);
  const working = live && (agent.status === 'working' || agent.status === 'starting');

  useEffect(() => {
    loadChat(agent.id);
  }, [agent.id, agent.runId]);

  const items = chat?.items ?? [];
  const blocks = useMemo(() => buildBlocks(items, agent, working), [items, agent, working]);

  // Follow new output while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks, agent.statusDetail]);
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [agent.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };

  const pendingApproval = items.some((i) => i.kind === 'approval' && i.state === 'pending');
  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {items.length === 0 ? (
            chat?.loading ? (
              <div className="chat-loading">
                <LoaderCircle size={16} className="spin" /> Loading conversation…
              </div>
            ) : (
              <Welcome agent={agent} />
            )
          ) : (
            blocks.map((block) => <div key={block.key}>{block.node}</div>)
          )}
          {chat?.error ? <div className="chat-notice error">{chat.error}</div> : null}
          {working && !pendingApproval ? (
            <div className="working">
              <LoaderCircle size={14} className="spin" />
              <span className="ellipsis">{agent.statusDetail || 'Working'}…</span>
            </div>
          ) : null}
        </div>
      </div>
      {!atBottom ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ArrowDown size={14} /> Latest
        </button>
      ) : null}
      <Composer agent={agent} />
    </div>
  );
}
