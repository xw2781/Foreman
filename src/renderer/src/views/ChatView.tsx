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
  ListEnd,
  LoaderCircle,
  Navigation,
  Pencil,
  Plug,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Square,
  SquareSlash,
  Terminal,
  TriangleAlert,
  Wrench,
  X
} from 'lucide-react';
import {
  LIVE_STATUSES,
  PROVIDER_LABEL,
  type AgentInfo,
  type ChatCommand,
  type ChatFileChange,
  type ChatItem,
  type ChatQuestion,
  type ChatSendMode,
  type ChatSettingsPatch
} from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { commandLists, drafts, loadChat, loadCommands, sendModes, useChats } from '../chats';
import { commandToken, rankCommands } from '../commands';
import { CopyButton, Markdown } from '../markdown';
import { folderName, percent, usd } from '../format';
import { ProviderIcon, Select, useFit } from '../ui';
import { PERMISSIONS, effortOptions, modelOptions } from './LaunchDialog';
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

function DiffCount({ files }: { files: ChatFileChange[] }) {
  const { added, removed } = diffStats(files);
  return (
    <span className="diff-count">
      {added ? <span className="plus">+{added}</span> : null} {removed ? <span className="minus">−{removed}</span> : null}
    </span>
  );
}

/** The folder holding `path`, relative to `root` when it lies inside it ('' for `root` itself). */
function folderOf(path: string, root: string | undefined) {
  const folder = path.replace(/[\\/][^\\/]*$/, '');
  if (!root) return folder;
  const same = (a: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const base = same(root);
  const dir = same(folder);
  if (dir === base) return '';
  return dir.startsWith(`${base}/`) ? folder.slice(base.length + 1) : folder;
}

/** A turn's successful edits, one entry per file in the order first touched. */
function turnChanges(items: ChatItem[]): ChatFileChange[] {
  const byPath = new Map<string, ChatFileChange>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'done' || !item.files) continue;
    for (const file of item.files) {
      const key = file.path.replace(/\\/g, '/').toLowerCase();
      const previous = byPath.get(key);
      if (!previous) {
        byPath.set(key, { ...file });
        continue;
      }
      const kind = file.kind === 'delete' ? 'delete' : previous.kind === 'add' ? 'add' : 'update';
      const diff = [previous.diff, file.diff.startsWith('@@') ? file.diff : `@@\n${file.diff}`].filter(Boolean).join('\n');
      byPath.set(key, { path: previous.path, kind, diff });
    }
  }
  return [...byPath.values()];
}

// ------------------------------------------------------------------ pieces

function DiffFile({ file, defaultOpen, root }: { file: ChatFileChange; defaultOpen: boolean; root?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const lines = useMemo(() => file.diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('diff --git') && !l.startsWith('index ')), [file.diff]);
  const shown = all ? lines : lines.slice(0, 80);
  const name = file.path.split(/[\\/]/).pop();
  return (
    <div className="diff-file">
      <button type="button" className="diff-head" onClick={() => setOpen(!open)} title={file.path}>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
        <span className="diff-name">{name}</span>
        <span className="diff-path ellipsis">{folderOf(file.path, root)}</span>
        {file.kind !== 'update' ? <span className={`badge ${file.kind === 'add' ? 'good' : 'critical'}`}>{file.kind === 'add' ? 'new' : 'deleted'}</span> : null}
        <DiffCount files={[file]} />
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

export function DiffView({ files, open, root }: { files: ChatFileChange[]; open?: boolean; root?: string }) {
  return (
    <div className="diff">
      {files.map((file) => (
        <DiffFile key={file.path} file={file} defaultOpen={open ?? files.length === 1} root={root} />
      ))}
    </div>
  );
}

/** Every file the turn changed, with its combined diff. */
function ChangesCard({ files, root }: { files: ChatFileChange[]; root: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="changes">
      <button type="button" className="changes-head" onClick={() => setOpen(!open)}>
        <FilePen size={14} />
        <span className="changes-title">
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <DiffCount files={files} />
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open ? <DiffView files={files} open={false} root={root} /> : null}
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
  const inputIsDetail = item.input && item.input === item.detail;
  return (
    <div className={`tool-row ${item.status} ${open ? 'open' : ''}`}>
      <button type="button" className="tool-line" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
        <span className="tool-icon">{toolIcon(item)}</span>
        <span className="tool-title">{item.status === 'running' ? IN_PROGRESS[item.title] ?? item.title : item.title}</span>
        {item.detail ? <span className={`tool-detail ellipsis ${item.tool.match(/bash|powershell|shell/i) ? 'mono' : ''}`}>{item.detail}</span> : null}
        {item.files?.length ? <DiffCount files={item.files} /> : null}
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

/** "3 edits · 1 failed", or the kinds of step taken when nothing stands out. */
function stepSummary(tools: Array<Item<'tool'>>) {
  const failed = tools.filter((i) => i.status === 'error').length;
  const edits = tools.filter((i) => i.files?.length).length;
  const notable = [edits ? `${edits} edit${edits === 1 ? '' : 's'}` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
  return notable || tools.map((i) => i.title).filter((t, index, all) => all.indexOf(t) === index).slice(0, 4).join(', ');
}

/** Consecutive tool calls; long finished runs fold into one line that toggles them. */
function ToolGroup({ items, active, defaultExpanded = false }: { items: Array<Item<'tool'>>; active: boolean; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const foldable = items.length > 3 && !active && items.every((i) => i.status !== 'running');
  return (
    <div className="tool-group">
      {foldable ? (
        <button type="button" className={`tool-line folded ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded(!expanded)} title={expanded ? 'Collapse steps' : 'Show steps'}>
          <span className="tool-icon">
            <Wrench size={14} />
          </span>
          <span className="tool-title">{items.length} steps</span>
          <span className="tool-detail ellipsis">{stepSummary(items)}</span>
          <ChevronRight size={13} className={`chev ${expanded ? 'open' : ''}`} />
        </button>
      ) : null}
      {!foldable || expanded ? items.map((item) => <ToolRow key={item.id} item={item} />) : null}
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

function TurnFooter({ item, showDuration }: { item: Item<'turn'>; showDuration: boolean }) {
  const parts = [showDuration && item.durationMs !== null ? `Worked for ${seconds(item.durationMs)}` : '', item.costUsd ? usd(item.costUsd, true) : ''].filter(Boolean);
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

/** A message sent into a running turn, marked as such so it doesn't read as a new prompt. */
function SteerMessage({ item }: { item: Item<'user'> }) {
  const waiting = item.delivery === 'steering';
  return (
    <div className={`msg-user steer ${waiting ? 'waiting' : ''}`}>
      <div className="msg-tag" title={waiting ? 'Sent into the running turn; the agent reads it after its current step' : 'The agent took this in without starting a new turn'}>
        {waiting ? <LoaderCircle size={11} className="spin" /> : <Navigation size={11} />}
        <span>{waiting ? 'Steering · waiting for the next step' : 'Steered mid-turn'}</span>
      </div>
      <div className="bubble selectable">{item.text}</div>
    </div>
  );
}

/** Renders a run of entries, folding consecutive tool calls into groups. */
function renderEntries(items: ChatItem[], agent: AgentInfo, activeTail: boolean, groupsOpen: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let tools: Array<Item<'tool'>> = [];
  const flush = (last: boolean) => {
    if (!tools.length) return;
    const group = tools;
    tools = [];
    nodes.push(<ToolGroup key={`g-${group[0].id}`} items={group} active={last && activeTail} defaultExpanded={groupsOpen} />);
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
        nodes.push(
          item.delivery ? (
            <SteerMessage key={item.id} item={item} />
          ) : (
            <div key={item.id} className="msg-user">
              <div className="bubble selectable">{item.text}</div>
            </div>
          )
        );
        break;
      case 'assistant':
        nodes.push(
          <div key={item.id} className={`msg-assistant ${item.streaming ? 'streaming' : ''}`}>
            <Markdown text={item.text} />
          </div>
        );
        break;
      case 'reasoning':
        nodes.push(<Reasoning key={item.id} item={item} />);
        break;
      case 'approval':
        nodes.push(<ApprovalCard key={item.id} item={item} agent={agent} />);
        break;
      case 'notice':
        nodes.push(<Notice key={item.id} item={item} />);
        break;
      default:
        break;
    }
  });
  return nodes;
}

/** A prompt and everything the agent did about it, up to its footer. */
interface TurnSlice {
  key: string;
  prompt: Item<'user'> | null;
  body: ChatItem[];
  footer: Item<'turn'> | null;
}

function splitTurns(items: ChatItem[]): TurnSlice[] {
  const turns: TurnSlice[] = [];
  let current: TurnSlice | null = null;
  for (const item of items) {
    // Queued messages wait above the composer until they're sent.
    if (item.kind === 'user' && item.delivery === 'queued') continue;
    // A steer belongs to the turn it went into.
    const steer = item.kind === 'user' && item.delivery !== undefined && current !== null && !current.footer;
    if (item.kind === 'user' && !steer) {
      current = { key: item.id, prompt: item, body: [], footer: null };
      turns.push(current);
      continue;
    }
    if (!current || current.footer) {
      current = { key: item.id, prompt: null, body: [], footer: null };
      turns.push(current);
    }
    if (item.kind === 'turn') current.footer = item;
    else current.body.push(item);
  }
  return turns;
}

function turnDuration(turn: TurnSlice): number | null {
  if (turn.footer?.durationMs != null) return turn.footer.durationMs;
  // Conversations rebuilt from history have no footers; their timestamps still bound the turn.
  const first = Date.parse((turn.prompt ?? turn.body[0])?.at ?? '');
  const last = Date.parse(turn.body[turn.body.length - 1]?.at ?? '');
  return Number.isFinite(first) && Number.isFinite(last) && last > first ? last - first : null;
}

/**
 * One turn. While it runs every step shows; once done the steps fold behind a
 * "Worked for …" line, leaving the closing message and the files it changed.
 */
const TurnView = memo(
  function TurnView({ turn, agent, done, active }: { turn: TurnSlice; agent: AgentInfo; done: boolean; active: boolean }) {
    const [open, setOpen] = useState(false);
    const pending = turn.body.some((i) => i.kind === 'approval' && i.state === 'pending');
    // The closing message(s): the trailing run of text after the last step.
    let cut = turn.body.length;
    while (cut > 0 && (turn.body[cut - 1].kind === 'assistant' || turn.body[cut - 1].kind === 'notice')) cut -= 1;
    const steps = turn.body.slice(0, cut);
    const fold = done && !pending && steps.length > 0;
    const changes = useMemo(() => (done ? turnChanges(turn.body) : []), [done, turn.body]);
    const duration = fold ? turnDuration(turn) : null;
    const tools = steps.filter((i): i is Item<'tool'> => i.kind === 'tool');
    // What the person said mid-turn stays in view when the steps fold.
    const steers = steps.filter((i) => i.kind === 'user');
    return (
      <div className="turn">
        {turn.prompt ? renderEntries([turn.prompt], agent, false, false) : null}
        {fold ? (
          <>
            <button type="button" className={`turn-fold ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title={open ? 'Collapse steps' : 'Show steps'}>
              <span>{duration !== null ? `Worked for ${seconds(duration)}` : 'Steps'}</span>
              <span className="turn-fold-detail ellipsis">
                {[tools.length ? `${tools.length} step${tools.length === 1 ? '' : 's'}` : '', stepSummary(tools)].filter(Boolean).join(' · ')}
              </span>
              <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
            </button>
            {open ? <div className="turn-steps">{renderEntries(steps, agent, false, true)}</div> : renderEntries(steers, agent, false, false)}
            {renderEntries(turn.body.slice(cut), agent, false, false)}
          </>
        ) : (
          renderEntries(turn.body, agent, active, false)
        )}
        {changes.length ? <ChangesCard files={changes} root={agent.cwd} /> : null}
        {turn.footer ? <TurnFooter item={turn.footer} showDuration={!fold} /> : null}
      </div>
    );
  },
  (a, b) =>
    a.done === b.done &&
    a.active === b.active &&
    a.agent.id === b.agent.id &&
    a.agent.cwd === b.agent.cwd &&
    a.agent.provider === b.agent.provider &&
    a.turn.prompt === b.turn.prompt &&
    a.turn.footer === b.turn.footer &&
    a.turn.body.length === b.turn.body.length &&
    a.turn.body.every((item, index) => item === b.turn.body[index])
);

// ------------------------------------------------------------- command menu

function CommandMenu({ commands, loading, active, onHover, onChoose }: { commands: ChatCommand[]; loading: boolean; active: number; onHover: (index: number) => void; onChoose: (command: ChatCommand) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, commands]);
  return (
    // Clicks mustn't take focus from the composer.
    <div className="command-menu" ref={ref} role="listbox" aria-label="Commands and skills" onMouseDown={(e) => e.preventDefault()}>
      {commands.length === 0 ? (
        <div className="command-empty">
          {loading ? (
            <>
              <LoaderCircle size={13} className="spin" /> Loading commands…
            </>
          ) : (
            'No matching commands or skills'
          )}
        </div>
      ) : (
        commands.map((c, index) => (
          <div
            key={`${c.trigger}${c.name}`}
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={`command-item ${index === active ? 'active' : ''}`}
            onMouseMove={() => index !== active && onHover(index)}
            onClick={() => onChoose(c)}
            title={c.description}
          >
            <span className="command-icon">{c.kind === 'skill' ? <Sparkles size={13} /> : <SquareSlash size={13} />}</span>
            <span className="command-name">
              {c.trigger}
              {c.name}
            </span>
            {c.argumentHint ? <span className="command-args">{c.argumentHint}</span> : null}
            <span className="command-desc ellipsis">
              {c.aliases.length ? <span className="command-aliases">{c.aliases.map((a) => `${c.trigger}${a}`).join(' ')} · </span> : null}
              {c.description}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ----------------------------------------------------------------- composer

type Telemetry = NonNullable<AgentInfo['telemetry']>;
type Usage = NonNullable<Telemetry['totalUsage']>;

function exact(n: number) {
  return n.toLocaleString();
}

function UsageRows({ usage, reasoning }: { usage: Usage; reasoning: boolean }) {
  return (
    <>
      <div className="tt-row">
        Input (uncached)<span className="v">{exact(Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens))}</span>
      </div>
      <div className="tt-row">
        Cache reads<span className="v">{exact(usage.cachedInputTokens)}</span>
      </div>
      <div className="tt-row">
        Cache writes<span className="v">{exact(usage.cacheWriteInputTokens)}</span>
      </div>
      <div className="tt-row">
        Output<span className="v">{exact(usage.outputTokens)}</span>
      </div>
      {reasoning && usage.reasoningOutputTokens ? (
        <div className="tt-row sub">
          of which reasoning<span className="v">{exact(usage.reasoningOutputTokens)}</span>
        </div>
      ) : null}
    </>
  );
}

/** The context ring's hover card: what fills the window, and the session's token totals. */
function ContextCard({ telemetry: t }: { telemetry: Telemetry }) {
  return (
    <div className="tooltip context-card" role="tooltip">
      <div className="tt-title">Context window</div>
      <div className="tt-row">
        Used
        <span className="v">
          {exact(t.contextUsedTokens)} / {exact(t.contextWindow)} · {percent(t.contextPercent)}
        </span>
      </div>
      {t.contextWindowAssumed ? <div className="tt-note">Window size assumed from the model</div> : null}
      {t.compactions ? (
        <div className="tt-row">
          Compactions<span className="v">{t.compactions}</span>
        </div>
      ) : null}
      {t.lastUsage ? (
        <>
          <div className="tt-title tt-section">Last request</div>
          <UsageRows usage={t.lastUsage} reasoning={false} />
        </>
      ) : null}
      {t.totalUsage ? (
        <>
          <div className="tt-title tt-section">Session total</div>
          <UsageRows usage={t.totalUsage} reasoning />
          <div className="tt-row tt-total">
            Total<span className="v">{exact(t.totalUsage.totalTokens)}</span>
          </div>
          <div className="tt-row">
            Requests<span className="v">{exact(t.requests)}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

const OTHER_MODE: Record<ChatSendMode, ChatSendMode> = { steer: 'queue', queue: 'steer' };

/** Messages waiting for the running turn to end, above the composer. */
function QueueTray({ agent, items, busy, onEdit }: { agent: AgentInfo; items: Array<Item<'user'>>; busy: boolean; onEdit: (text: string) => void }) {
  const toast = useApp((s) => s.toast);
  const name = PROVIDER_LABEL[agent.provider];
  const act = (item: Item<'user'>, action: 'send' | 'remove') => call('chat.queued', agent.id, item.id, action);
  const run = (promise: Promise<unknown>) => promise.catch((error) => toast('error', errorMessage(error)));
  return (
    <div className="queue" aria-label="Queued messages">
      <div className="queue-head">
        <ListEnd size={12} />
        <span>
          {items.length} queued · {agent.endedAt ? 'not sent: the conversation ended' : busy ? `sent one at a time after ${name} finishes this turn` : 'sending…'}
        </span>
      </div>
      {items.map((item) => (
        <div key={item.id} className="queue-item">
          <span className="queue-text selectable">{item.text}</span>
          <button
            type="button"
            className="btn ghost sm icon"
            title={busy ? 'Steer now: send it into the running turn' : 'Send now'}
            aria-label={busy ? 'Steer now' : 'Send now'}
            onClick={() => run(act(item, 'send'))}
          >
            {busy ? <Navigation size={13} /> : <ArrowUp size={14} />}
          </button>
          <button type="button" className="btn ghost sm icon" title="Edit: take it off the queue, back into the message box" aria-label="Edit" onClick={() => run(act(item, 'remove').then(() => onEdit(item.text)))}>
            <Pencil size={13} />
          </button>
          <button type="button" className="btn ghost sm icon" title="Remove from the queue" aria-label="Remove" onClick={() => run(act(item, 'remove'))}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function Composer({ agent, queued }: { agent: AgentInfo; queued: Array<Item<'user'>> }) {
  const toast = useApp((s) => s.toast);
  const [text, setText] = useState(() => drafts.get(agent.id) ?? '');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const live = !agent.endedAt;
  const working = live && (agent.status === 'working' || agent.status === 'starting');
  // While a turn runs (or waits on an approval) a message steers it or waits in the queue.
  const midTurn = live && (agent.status === 'working' || agent.status === 'needs-input');
  const defaultMode = useApp((s) => s.settings?.chatSendMode ?? 'steer');
  const [modeOverride, setModeOverride] = useState(() => sendModes.get(agent.id));
  const mode = modeOverride ?? defaultMode;
  const name = PROVIDER_LABEL[agent.provider];
  const t = agent.telemetry;
  const hintRow = useFit<HTMLDivElement>([agent.id, midTurn, working, mode]);

  // The command menu: opened by typing "/" (or "$" for a Codex skill), or from its button to browse.
  const [caret, setCaret] = useState(0);
  const [browsing, setBrowsing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [commands, setCommands] = useState<ChatCommand[] | null>(() => commandLists.get(agent.id) ?? null);
  const [loadingCommands, setLoadingCommands] = useState(false);
  const token = commandToken(text, caret, agent.provider === 'codex');
  const tokenKey = token ? `${token.trigger}${token.start}` : null;
  const typed = token && tokenKey !== dismissed ? token : null;
  const menuOpen = browsing || typed !== null;
  const shown = useMemo(() => {
    if (!menuOpen || !commands) return [];
    return typed ? rankCommands(commands.filter((c) => c.trigger === typed.trigger), typed.query) : commands;
  }, [menuOpen, commands, typed?.trigger, typed?.query]);

  useEffect(() => {
    setText(drafts.get(agent.id) ?? '');
    setModeOverride(sendModes.get(agent.id));
    setBrowsing(false);
    setDismissed(null);
    setCommands(commandLists.get(agent.id) ?? null);
    ref.current?.focus();
  }, [agent.id]);
  useEffect(() => {
    if (!token && dismissed) setDismissed(null);
  }, [token === null]);
  useEffect(() => setActive(0), [menuOpen, typed?.trigger, typed?.query]);
  // A fresh list each time the menu opens: skills can come and go mid-session.
  useEffect(() => {
    if (!menuOpen) return;
    let current = true;
    setLoadingCommands(true);
    loadCommands(agent.id)
      .then((list) => current && setCommands(list))
      .catch(() => {})
      .finally(() => current && setLoadingCommands(false));
    return () => {
      current = false;
    };
  }, [menuOpen, agent.id, agent.runId]);

  /** Puts the command into the message; returns the new text. */
  const complete = (command: ChatCommand) => {
    const name = `${command.trigger}${command.name} `;
    let head: string;
    let rest: string;
    if (typed && typed.trigger === command.trigger) {
      head = text.slice(0, typed.start) + name;
      rest = text.slice(typed.end).replace(/^ /, '');
    } else if (command.trigger === '/') {
      // Browsing: the command goes first, whatever was written becomes its arguments.
      head = name;
      rest = text.replace(/^\/\S*\s*/, '');
    } else {
      const before = text.slice(0, caret);
      head = before + (before && !/\s$/.test(before) ? ' ' : '') + name;
      rest = text.slice(caret).replace(/^ /, '');
    }
    const next = head + rest;
    update(next);
    setBrowsing(false);
    setCaret(head.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(head.length, head.length);
    });
    return next;
  };

  const menuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return false;
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
      return true;
    }
    if (e.key === 'Escape') {
      if (browsing) setBrowsing(false);
      else setDismissed(tokenKey);
      return true;
    }
    if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && shown[active]) {
      const command = shown[active];
      // Enter on a command typed out in full runs it; otherwise it's completed first.
      const exact = e.key === 'Enter' && typed !== null && (typed.query === command.name || command.aliases.includes(typed.query)) && !text.slice(typed.end).trim();
      const next = complete(command);
      if (exact) send(next);
      return true;
    }
    return false;
  };
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

  const send = async (value = text, how: ChatSendMode = mode) => {
    const message = value.trim();
    if (!message || sending) return;
    setSending(true);
    update('');
    try {
      await call('chat.send', agent.id, message, how);
    } catch (error) {
      update(message);
      toast('error', errorMessage(error));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const chooseMode = (next: ChatSendMode) => {
    if (next === defaultMode) sendModes.delete(agent.id);
    else sendModes.set(agent.id, next);
    setModeOverride(sendModes.get(agent.id));
    ref.current?.focus();
  };

  /** Puts `texts` ahead of what's being written. */
  const restore = (texts: string[]) => {
    if (!texts.length) return;
    update([...texts, drafts.get(agent.id) ?? ''].filter((t) => t.trim()).join('\n\n'));
    ref.current?.focus();
  };

  // Queued messages come back into the message box, as in both CLIs' own apps.
  const stop = () =>
    call('chat.interrupt', agent.id)
      .then(restore)
      .catch((error) => toast('error', errorMessage(error)));

  const configure = (patch: ChatSettingsPatch) => call('chat.configure', agent.id, patch).catch((error) => toast('error', errorMessage(error)));
  const profile = useApp((s) => s.profiles.find((p) => p.id === agent.profileId));
  const currentModel = agent.model ?? '';
  // What the session runs at: the level chosen here or at launch, else the CLI's configured default.
  const currentEffort = agent.effort || profile?.cliDefaults.effort || '';

  return (
    <div className="composer">
      {queued.length ? <QueueTray agent={agent} items={queued} busy={midTurn} onEdit={(queuedText) => restore([queuedText])} /> : null}
      <div className="composer-box">
        {menuOpen ? <CommandMenu commands={shown} loading={loadingCommands || !commands} active={active} onHover={setActive} onChoose={complete} /> : null}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={
            !live
              ? 'Send a message to continue this conversation'
              : midTurn
                ? mode === 'steer'
                  ? `Steer ${name}: it reads this after its current step`
                  : `Queue a message for when ${name} finishes this turn`
                : `Message ${name}…`
          }
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          onChange={(e) => {
            update(e.target.value);
            setCaret(e.target.selectionStart);
            setBrowsing(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => {
            setBrowsing(false);
            if (tokenKey) setDismissed(tokenKey);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (menuOpen && menuKey(e)) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(text, e.ctrlKey || e.metaKey ? OTHER_MODE[mode] : mode);
            }
            if (e.key === 'Escape' && working) stop();
          }}
        />
        <div className="composer-bar">
          <button
            type="button"
            className={`composer-commands ${browsing ? 'on' : ''}`}
            title={agent.provider === 'codex' ? 'Commands and skills (/ or $)' : 'Commands and skills (/)'}
            aria-label="Commands and skills"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setBrowsing(!browsing);
              ref.current?.focus();
            }}
          >
            <SquareSlash size={14} />
          </button>
          <Select
            variant="ghost"
            size="sm"
            heading="Permissions"
            icon={<Shield size={13} />}
            aria-label="Permissions"
            value={agent.permission ?? 'default'}
            options={PERMISSIONS[agent.provider].map((p) => ({ value: p.value, label: p.label, hint: p.hint }))}
            onChange={(permission) => configure({ permission })}
          />
          <Select
            variant="ghost"
            size="sm"
            heading="Model"
            aria-label="Model"
            value={currentModel}
            options={modelOptions(agent.provider, profile?.cliDefaults, currentModel)}
            custom={{ placeholder: 'Other model id…' }}
            onChange={(model) => configure({ model })}
          />
          <Select
            variant="ghost"
            size="sm"
            heading="Reasoning effort"
            icon={<Brain size={13} />}
            aria-label="Reasoning effort"
            title="Reasoning effort"
            value={currentEffort}
            // Once a level is in force there's no "default" to go back to mid-session.
            options={effortOptions(agent.provider, profile?.cliDefaults.effort, currentEffort).filter((o) => o.value || !currentEffort)}
            onChange={(effort) => effort && configure({ effort })}
          />
          {/* Wraps to a line of its own rather than squeezing the controls' labels. */}
          <div className="composer-send">
            {t && t.contextPercent !== null ? (
              <span className="composer-context" tabIndex={0} aria-label={`Context window ${percent(t.contextPercent)} used`}>
                <ContextCard telemetry={t} />
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
                <span>{percent(t.contextPercent)}</span>
              </span>
            ) : null}
            {working && !text.trim() ? (
              <button type="button" className="send-btn stop" title="Stop (Esc)" onClick={stop}>
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                title={midTurn ? `${mode === 'steer' ? 'Steer the running turn' : 'Queue for when this turn ends'} (Enter) · Ctrl+Enter to ${OTHER_MODE[mode]}` : 'Send (Enter)'}
                disabled={!text.trim() || sending}
                onClick={() => send()}
              >
                {sending ? <LoaderCircle size={15} className="spin" /> : midTurn && mode === 'steer' ? <Navigation size={15} /> : midTurn ? <ListEnd size={16} /> : <ArrowUp size={16} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {/* One line: the send mode while the agent works, then key hints, the least useful left out first when narrow. */}
      <div className="composer-hint" ref={hintRow}>
        {midTurn ? (
          <div className="send-mode" role="radiogroup" aria-label={`While ${name} works`}>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'steer'}
              className={mode === 'steer' ? 'on' : ''}
              title="Steer: your message goes into the running turn; the agent reads it after its current step"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => chooseMode('steer')}
            >
              <Navigation size={12} />
              Steer
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'queue'}
              className={mode === 'queue' ? 'on' : ''}
              title="Queue: your message waits until this turn ends, then goes as the next prompt"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => chooseMode('queue')}
            >
              <ListEnd size={12} />
              Queue
            </button>
          </div>
        ) : null}
        <span className="composer-keys">
          <span>
            <span className="kbd">Enter</span> {midTurn ? mode : 'send'}
          </span>
          {midTurn ? (
            <span data-fit="1">
              {' · '}
              <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> {OTHER_MODE[mode]}
            </span>
          ) : null}
          <span data-fit="3">
            {' · '}
            <span className="kbd">Shift</span>+<span className="kbd">Enter</span> new line
          </span>
          <span data-fit="4">
            {' · '}
            <span className="kbd">/</span> commands
          </span>
          {agent.provider === 'codex' ? (
            <span data-fit="5">
              {' · '}
              <span className="kbd">$</span> skills
            </span>
          ) : null}
          {working ? (
            <span data-fit="2">
              {' · '}
              <span className="kbd">Esc</span> stop
            </span>
          ) : null}
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
  const turns = useMemo(() => splitTurns(items), [items]);
  const queued = useMemo(() => items.filter((i): i is Item<'user'> => i.kind === 'user' && i.delivery === 'queued'), [items]);

  // Follow new output while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, working, agent.statusDetail]);
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
            turns.map((turn, index) => {
              const last = index === turns.length - 1;
              return <TurnView key={turn.key} turn={turn} agent={agent} done={Boolean(turn.footer) || !last || !working} active={last && working} />;
            })
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
      <Composer agent={agent} queued={queued} />
    </div>
  );
}
