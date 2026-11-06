import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, CloudOff, FolderGit2, FolderOpen, GitBranch,
  GitCommitHorizontal, GitFork, Layers, LoaderCircle, Lock, Maximize2, Minimize2, RotateCw
} from 'lucide-react';
import { create } from 'zustand';
import type { AgentInfo, GitCommitDetails, GitDiff, GitDiffTarget, GitFileChange, GitLineStats, GitStatus, GitWorktree } from '@shared/types';
import { call, errorMessage } from '../api';
import { ago, folderName, fullTime } from '../format';
import { Empty } from '../ui';
import { useApp } from '../store';
import { parseDiff, splitPath, worktreeOf } from '../gitDiff';
import { fileRowProps } from '../FileMenu';
import { joinPath } from '../fileRefs';

/** What a file row needs to be referenced: paths in git output are relative to `root`. */
interface RefBase { agentId: string; cwd: string; root: string }

const refProps = (base: RefBase, path: string, missing?: boolean) => fileRowProps({ agentId: base.agentId, cwd: base.cwd, full: joinPath(base.root, path), missing });

type GitView = 'changes' | 'commits' | 'worktrees';
type Loaded<T> = T | { error: string } | 'loading';
type Section = 'conflicts' | 'staged' | 'unstaged' | 'untracked';

interface GitPanelState {
  status: Loaded<GitStatus> | null;
  /** A refresh is running over a status already shown. */
  refreshing: boolean;
  view: GitView;
  diff: { target: GitDiffTarget; data: Loaded<GitDiff> } | null;
  /** The commit expanded in the history, and each loaded commit's files. */
  openCommit: string | null;
  commits: Record<string, Loaded<GitCommitDetails>>;
  collapsed: Partial<Record<Section, boolean>>;
}

const EMPTY: GitPanelState = { status: null, refreshing: false, view: 'changes', diff: null, openCommit: null, commits: {}, collapsed: {} };

/** Each agent's Git tab, kept while the panel shows another tab or another agent. */
export const useGit = create<Record<string, GitPanelState>>(() => ({}));

function patch(agentId: string, change: Partial<GitPanelState> | ((state: GitPanelState) => Partial<GitPanelState>)) {
  useGit.setState((all) => {
    const current = all[agentId] ?? EMPTY;
    return { [agentId]: { ...current, ...(typeof change === 'function' ? change(current) : change) } };
  });
}

const inFlight = new Set<string>();

export async function loadGitStatus(agentId: string) {
  if (inFlight.has(agentId)) return;
  inFlight.add(agentId);
  patch(agentId, (s) => (s.status && s.status !== 'loading' ? { refreshing: true } : { status: 'loading' }));
  let status: Loaded<GitStatus>;
  try {
    status = await call('git.status', agentId);
  } catch (error) {
    status = { error: errorMessage(error) };
  } finally {
    inFlight.delete(agentId);
  }
  patch(agentId, { status, refreshing: false });
  // The diff on screen may be out of date too.
  const diff = useGit.getState()[agentId]?.diff;
  if (diff) loadDiff(agentId, diff.target, true);
}

async function loadDiff(agentId: string, target: GitDiffTarget, quiet = false) {
  if (!quiet) patch(agentId, { diff: { target, data: 'loading' } });
  let data: Loaded<GitDiff>;
  try {
    data = await call('git.diff', agentId, target);
  } catch (error) {
    data = { error: errorMessage(error) };
  }
  patch(agentId, (s) => (s.diff?.target === target ? { diff: { target, data } } : {}));
}

async function loadCommit(agentId: string, hash: string) {
  patch(agentId, (s) => ({ commits: { ...s.commits, [hash]: 'loading' } }));
  let details: Loaded<GitCommitDetails>;
  try {
    details = await call('git.commit', agentId, hash);
  } catch (error) {
    details = { error: errorMessage(error) };
  }
  patch(agentId, (s) => ({ commits: { ...s.commits, [hash]: details } }));
}

/** How many files the Git tab lists as changed, once it has looked (for the tab's badge). */
export function useGitChangeCount(agentId: string): number {
  return useGit((s) => {
    const status = s[agentId]?.status;
    return status && status !== 'loading' && !('error' in status) && status.repo ? status.files.length + status.omittedFiles : 0;
  });
}

const OPERATION_LABEL = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', bisect: 'Bisect' } as const;

const LETTER_TITLE: Record<string, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', '!': 'Conflict', '?': 'Untracked'
};
/** CSS-safe names for the letters' colors. */
const LETTER_CLASS: Record<string, string> = { M: 'mod', T: 'mod', A: 'add', C: 'add', '?': 'add', D: 'del', R: 'ren', '!': 'conflict' };

function sections(files: GitFileChange[]) {
  const out: Record<Section, GitFileChange[]> = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  for (const file of files) {
    if (file.conflict) out.conflicts.push(file);
    else if (file.index === '?') out.untracked.push(file);
    else {
      // A partly staged file is in both lists, as in git status.
      if (file.index !== '.') out.staged.push(file);
      if (file.worktree !== '.') out.unstaged.push(file);
    }
  }
  return out;
}

function Stats({ stats }: { stats: GitLineStats | undefined }) {
  if (stats === undefined) return null;
  if (stats === null) return <span className="git-stats muted">binary</span>;
  return (
    <span className="git-stats">
      {stats.added ? <span className="git-add">+{stats.added}</span> : null}
      {stats.removed ? <span className="git-del">−{stats.removed}</span> : null}
    </span>
  );
}

function Letter({ letter }: { letter: string }) {
  return <span className={`git-letter l-${LETTER_CLASS[letter] ?? 'mod'}`} title={LETTER_TITLE[letter] ?? letter}>{letter === '?' ? 'U' : letter}</span>;
}

function FileRow({ base, file, letter, stats, selected, onClick }: { base: RefBase; file: { path: string; origPath?: string }; letter: string; stats?: GitLineStats; selected: boolean; onClick: () => void }) {
  const { name, dir } = splitPath(file.path);
  return (
    <button type="button" className={`ft-row git-file ${selected ? 'on' : ''}`} onClick={onClick} {...refProps(base, file.path, letter === 'D')}
      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
      <Letter letter={letter} />
      <span className="git-file-name ellipsis">
        {name}
        {dir ? <span className="git-file-dir"> {dir}</span> : null}
      </span>
      <Stats stats={stats} />
    </button>
  );
}

function sameTarget(a: GitDiffTarget | undefined, b: GitDiffTarget) {
  return Boolean(a && a.kind === b.kind && a.path === b.path && (a.kind !== 'commit' || (b.kind === 'commit' && a.hash === b.hash)));
}

function ChangesView({ agentId, base, status, state }: { agentId: string; base: RefBase; status: Extract<GitStatus, { repo: true }>; state: GitPanelState }) {
  const groups = useMemo(() => sections(status.files), [status.files]);
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of status.files) for (const s of [f.staged, f.unstaged]) if (s) { added += s.added; removed += s.removed; }
    return { added, removed };
  }, [status.files]);
  if (!status.files.length) {
    return (
      <div className="git-empty">
        <Empty icon={<Check size={22} />} title="Working tree clean">Nothing to commit{status.ahead ? `; ${status.ahead} commit${status.ahead === 1 ? '' : 's'} not pushed yet` : ''}.</Empty>
      </div>
    );
  }
  const list: Array<{ id: Section; label: string; files: GitFileChange[]; letter: (f: GitFileChange) => string; stats: (f: GitFileChange) => GitLineStats | undefined; kind: 'staged' | 'unstaged' | 'untracked' }> = [
    { id: 'conflicts', label: 'Conflicts', files: groups.conflicts, letter: () => '!', stats: (f) => f.unstaged, kind: 'unstaged' },
    { id: 'staged', label: 'Staged', files: groups.staged, letter: (f) => f.index, stats: (f) => f.staged, kind: 'staged' },
    { id: 'unstaged', label: 'Unstaged', files: groups.unstaged, letter: (f) => f.worktree, stats: (f) => f.unstaged, kind: 'unstaged' },
    { id: 'untracked', label: 'Untracked', files: groups.untracked, letter: () => '?', stats: () => undefined, kind: 'untracked' }
  ];
  const fileCount = status.files.length + status.omittedFiles;
  return (
    <div className="git-scroll">
      <div className="git-total">
        {fileCount} file{fileCount === 1 ? '' : 's'} changed
        {totals.added || totals.removed ? <Stats stats={totals} /> : null}
      </div>
      {list.filter((s) => s.files.length).map((section) => {
        const collapsed = Boolean(state.collapsed[section.id]);
        return (
          <div key={section.id} className={`git-section ${section.id}`}>
            <button type="button" className="git-section-head" aria-expanded={!collapsed}
              onClick={() => patch(agentId, (s) => ({ collapsed: { ...s.collapsed, [section.id]: !collapsed } }))}>
              {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              {section.id === 'conflicts' ? <AlertTriangle size={12} /> : null}
              <span>{section.label}</span>
              <span className="git-count">{section.files.length}</span>
            </button>
            {collapsed ? null : section.files.map((file) => {
              const target: GitDiffTarget = { kind: section.kind, path: file.path, ...(file.origPath ? { origPath: file.origPath } : {}) };
              return (
                <FileRow base={base} key={`${section.id}:${file.path}`} file={file} letter={section.letter(file)} stats={section.stats(file)}
                  selected={sameTarget(state.diff?.target, target)} onClick={() => loadDiff(agentId, target)} />
              );
            })}
          </div>
        );
      })}
      {status.omittedFiles ? <div className="ft-note">{status.omittedFiles} more changed files not listed</div> : null}
    </div>
  );
}

function CommitRow({ agentId, base, commit, head, state }: { agentId: string; base: RefBase; commit: Extract<GitStatus, { repo: true }>['commits'][number]; head: boolean; state: GitPanelState }) {
  const open = state.openCommit === commit.hash;
  const details = state.commits[commit.hash];
  const toggle = () => {
    patch(agentId, { openCommit: open ? null : commit.hash });
    if (!open && (!details || (details !== 'loading' && 'error' in details))) loadCommit(agentId, commit.hash);
  };
  const body = details && details !== 'loading' && !('error' in details) ? details.message.split('\n').slice(1).join('\n').trim() : '';
  return (
    <div className={`git-commit ${commit.pushed ? 'pushed' : 'local'} ${open ? 'open' : ''}`}>
      <button type="button" className="git-commit-head" aria-expanded={open} onClick={toggle}
        title={`${commit.hash}\n${commit.author} · ${fullTime(commit.date)}${commit.pushed ? '' : '\nNot on any remote yet'}`}>
        <span className="git-rail" aria-hidden="true"><span className="git-dot" /></span>
        <span className="git-commit-text">
          <span className="git-commit-subject ellipsis">{commit.subject || '(no message)'}</span>
          <span className="git-commit-meta">
            <code>{commit.short}</code>
            {head ? <span className="git-tag">HEAD</span> : null}
            <span className="ellipsis">{commit.author}</span>
            <span>· {ago(commit.date)}</span>
          </span>
        </span>
      </button>
      {open ? (
        <div className="git-commit-body">
          {!details || details === 'loading' ? (
            <div className="ft-note"><LoaderCircle size={12} className="spin" /> Loading…</div>
          ) : 'error' in details ? (
            <div className="ft-note error">{details.error}</div>
          ) : (
            <>
              {body ? <pre className="git-message selectable">{body}</pre> : null}
              {details.files.length ? details.files.map((file) => {
                const target: GitDiffTarget = { kind: 'commit', hash: commit.hash, path: file.path, ...(file.origPath ? { origPath: file.origPath } : {}) };
                return (
                  <FileRow base={base} key={file.path} file={file} letter={file.origPath ? 'R' : 'M'} stats={file.stats}
                    selected={sameTarget(state.diff?.target, target)} onClick={() => loadDiff(agentId, target)} />
                );
              }) : <div className="ft-note">No file changes</div>}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CommitsView({ agentId, base, status, state }: { agentId: string; base: RefBase; status: Extract<GitStatus, { repo: true }>; state: GitPanelState }) {
  if (!status.commits.length) {
    return <div className="git-empty"><Empty icon={<GitCommitHorizontal size={22} />} title="No commits yet" /></div>;
  }
  const local = status.commits.filter((c) => !c.pushed);
  const pushed = status.commits.filter((c) => c.pushed);
  const group = (label: ReactNode, commits: typeof status.commits) => (
    <div className="git-section">
      <div className="git-section-head static">{label}</div>
      {commits.map((commit) => <CommitRow key={commit.hash} agentId={agentId} base={base} commit={commit} head={commit.hash === status.head?.hash} state={state} />)}
    </div>
  );
  return (
    <div className="git-scroll">
      {!status.remotes ? (
        group(<><CloudOff size={12} /><span>No remote: every commit is only on this computer</span></>, status.commits)
      ) : (
        <>
          {local.length ? group(<><ArrowUp size={12} /><span>Not pushed</span><span className="git-count">{status.unpushed}</span></>, local) : null}
          {pushed.length ? group(<span>{local.length ? 'Pushed' : 'History'}</span>, pushed) : null}
        </>
      )}
    </div>
  );
}

function WorktreesView({ status }: { status: Extract<GitStatus, { repo: true }> }) {
  const agents = useApp((s) => s.agents);
  const paths = status.worktrees.map((w) => w.path);
  const sessions = (tree: GitWorktree) => agents.filter((a) => !a.projectless && worktreeOf(a.cwd, paths) === tree.path);
  return (
    <div className="git-scroll git-worktrees">
      {status.worktrees.map((tree) => {
        const here = sessions(tree);
        return (
          <div key={tree.path} className={`git-worktree ${tree.current ? 'current' : ''}`}>
            <div className="git-worktree-head">
              <FolderGit2 size={14} />
              <span className="git-worktree-name ellipsis" title={tree.path}>{folderName(tree.path)}</span>
              {tree.current ? <span className="git-tag accent">This session</span> : null}
              {tree.main ? <span className="git-tag">Main</span> : null}
              {tree.locked !== null ? <span className="git-tag" title={tree.locked || 'Locked'}><Lock size={10} /> Locked</span> : null}
              {tree.prunable !== null ? <span className="git-tag warn" title={tree.prunable || "Its folder is gone; git worktree prune removes it"}>Prunable</span> : null}
              <button className="btn ghost icon sm" title="Open the folder" aria-label={`Open ${tree.path}`} onClick={() => call('shell.openPath', tree.path).catch(() => {})}>
                <FolderOpen size={13} />
              </button>
            </div>
            <div className="git-worktree-line">
              {tree.bare ? <span className="muted">bare repository</span> : tree.branch ? (
                <><GitBranch size={12} /><span className="ellipsis">{tree.branch}</span></>
              ) : (
                <span className="muted">detached at <code>{tree.head.slice(0, 7)}</code></span>
              )}
            </div>
            <div className="git-worktree-path ellipsis" title={tree.path}>{tree.path}</div>
            {here.length ? (
              <div className="git-worktree-sessions">
                {here.map((agent) => (
                  <button key={agent.id} type="button" className="git-session" title="Show this session"
                    onClick={() => useApp.setState({ view: 'agents', selectedAgentId: agent.id })}>
                    <span className={`git-session-dot s-${agent.status}`} />
                    <span className="ellipsis">{agent.title || folderName(agent.cwd)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {status.worktrees.length === 1 ? (
        <div className="ft-note">Only the main working tree. Agents started in a worktree (git worktree add) show up here.</div>
      ) : null}
    </div>
  );
}

function DiffPane({ agentId, base, diff, expanded, onExpand }: { agentId: string; base: RefBase; diff: NonNullable<GitPanelState['diff']>; expanded: boolean; onExpand?: () => void }) {
  const { target, data } = diff;
  const rows = useMemo(() => (data !== 'loading' && !('error' in data) ? parseDiff(data.text) : []), [data]);
  const where = target.kind === 'commit' ? `Commit ${target.hash.slice(0, 7)}` : target.kind === 'untracked' ? 'New file' : target.kind === 'staged' ? 'Staged' : 'Unstaged';
  return (
    <div className="fp git-diff">
      <div className="sp-bar fp-head">
        <button type="button" className="btn ghost icon sm" aria-label="Back to the list" title="Back" onClick={() => patch(agentId, { diff: null })}>
          <ArrowLeft size={14} />
        </button>
        <span className="fp-name ellipsis" title={target.origPath ? `${target.origPath} → ${target.path}` : target.path} {...refProps(base, target.path)}>{target.path}</span>
        <span className="git-tag">{where}</span>
        {onExpand ? (
          <button type="button" className="btn ghost icon sm" aria-label={expanded ? 'Narrow the diff' : 'Widen the diff'}
            title={expanded ? 'Swap widths back: the conversation gets its column again' : 'Widen the diff: swap widths with the conversation'} onClick={onExpand}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        ) : null}
      </div>
      <div className="fp-body">
        {data === 'loading' ? (
          <div className="ft-note"><LoaderCircle size={12} className="spin" /> Loading…</div>
        ) : 'error' in data ? (
          <div className="ft-note error">{data.error}</div>
        ) : data.binary ? (
          <div className="ft-note">Binary file: no text diff.</div>
        ) : !rows.length ? (
          <div className="ft-note">No differences.</div>
        ) : (
          <>
            {data.truncated ? <div className="fp-notice">This diff is long; only its beginning is shown.</div> : null}
            <div className="diff-table selectable" role="table" aria-label={`Diff of ${target.path}`}>
              {rows.map((row, i) => (
                <div key={i} className={`diff-row d-${row.kind}`} role="row">
                  <span className="diff-num" aria-hidden="true">{row.old ?? ''}</span>
                  <span className="diff-num" aria-hidden="true">{row.new ?? ''}</span>
                  <span className="diff-sign" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ''}</span>
                  <span className="diff-text">{row.text || ' '}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SyncChip({ status }: { status: Extract<GitStatus, { repo: true }> }) {
  if (!status.branch) return <span className="git-chip warn" title="HEAD isn't on a branch">detached</span>;
  if (!status.upstream) {
    return <span className="git-chip" title={status.remotes ? 'This branch has no upstream: it has never been pushed, or tracks nothing' : 'The repository has no remote'}>
      <CloudOff size={11} /> {status.remotes ? 'not published' : 'local only'}
    </span>;
  }
  if (status.upstreamGone) return <span className="git-chip warn" title={`${status.upstream} no longer exists on the remote`}>{status.upstream} gone</span>;
  if (!status.ahead && !status.behind) return <span className="git-chip good" title={`Up to date with ${status.upstream} (as of the last fetch)`}><Check size={11} /> {status.upstream}</span>;
  return (
    <span className="git-chip" title={`${status.ahead} to push, ${status.behind} to pull from ${status.upstream} (as of the last fetch)`}>
      {status.ahead ? <span><ArrowUp size={11} />{status.ahead}</span> : null}
      {status.behind ? <span><ArrowDown size={11} />{status.behind}</span> : null}
      <span className="ellipsis">{status.upstream}</span>
    </span>
  );
}

/** The side panel's Git tab: branch and sync state, working-tree changes with diffs, recent commits and worktrees. Read-only. */
export function GitPanel({ agent, expanded, onExpand }: { agent: AgentInfo; expanded: boolean; onExpand?: () => void }) {
  const state = useGit((s) => s[agent.id]) ?? EMPTY;
  const [, force] = useState(0);
  useEffect(() => {
    loadGitStatus(agent.id);
    const onFocus = () => loadGitStatus(agent.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [agent.id]);
  // The agent is likely changing files: look again when its turn ends, and now and then while it works.
  useEffect(() => {
    if (agent.status !== 'working') {
      loadGitStatus(agent.id);
      return;
    }
    const timer = setInterval(() => document.visibilityState === 'visible' && loadGitStatus(agent.id), 8000);
    return () => clearInterval(timer);
  }, [agent.id, agent.status]);
  // Keeps the relative commit times fresh.
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const status = state.status;
  if (!status || status === 'loading') {
    return <div className="sp-pane git-pane"><div className="ft-note"><LoaderCircle size={12} className="spin" /> Reading the repository…</div></div>;
  }
  if ('error' in status) {
    return (
      <div className="sp-pane git-pane git-empty">
        <Empty icon={<AlertTriangle size={22} />} title="Couldn't read the repository" action={<button className="btn sm" onClick={() => loadGitStatus(agent.id)}><RotateCw size={13} /> Try again</button>}>
          {status.error}
        </Empty>
      </div>
    );
  }
  if (!status.repo) {
    return <div className="sp-pane git-pane git-empty"><Empty icon={<GitBranch size={22} />} title="No git repository">{status.reason}</Empty></div>;
  }
  const base: RefBase = { agentId: agent.id, cwd: agent.cwd, root: status.root };
  if (state.diff) return <div className="sp-pane git-pane"><DiffPane agentId={agent.id} base={base} diff={state.diff} expanded={expanded} onExpand={onExpand} /></div>;

  const current = status.worktrees.find((w) => w.current);
  const linked = current && !current.main;
  const fileCount = status.files.length + status.omittedFiles;
  return (
    <div className="sp-pane git-pane">
      <div className="sp-bar git-bar">
        <GitBranch size={14} className="git-bar-icon" />
        <span className="git-branch ellipsis" title={status.root}>
          {status.branch ?? <>detached at <code>{status.head?.short}</code></>}
        </span>
        <SyncChip status={status} />
        <button className="btn ghost icon sm" title="Refresh" onClick={() => loadGitStatus(agent.id)}>
          <RotateCw size={13} className={state.refreshing ? 'spin' : ''} />
        </button>
      </div>
      <div className="git-summary">
        {status.head ? (
          <div className="git-head-line" title={`${status.head.hash}\n${status.head.subject}`}>
            <GitCommitHorizontal size={12} />
            <code>{status.head.short}</code>
            <span className="ellipsis">{status.head.subject}</span>
          </div>
        ) : <div className="git-head-line muted">No commits yet</div>}
        {linked || status.operation || status.stashes ? (
          <div className="git-flags">
            {linked ? <span className="git-tag accent" title={`A linked worktree of ${status.worktrees[0]?.path ?? 'the repository'}`}><GitFork size={10} /> Worktree · {folderName(status.root)}</span> : null}
            {status.operation ? <span className="git-tag warn"><AlertTriangle size={10} /> {OPERATION_LABEL[status.operation]} in progress</span> : null}
            {status.stashes ? <span className="git-tag" title="git stash list"><Layers size={10} /> {status.stashes} stash{status.stashes === 1 ? '' : 'es'}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="git-views segmented" role="tablist">
        {([
          ['changes', 'Changes', fileCount],
          ['commits', 'Commits', status.remotes ? status.unpushed : 0],
          ['worktrees', 'Worktrees', status.worktrees.length > 1 ? status.worktrees.length : 0]
        ] as Array<[GitView, string, number]>).map(([id, label, count]) => (
          <button key={id} type="button" role="tab" aria-selected={state.view === id} className={state.view === id ? 'on' : ''}
            title={id === 'commits' && count ? `${count} not pushed` : undefined} onClick={() => patch(agent.id, { view: id })}>
            {label}
            {count ? <span className={`git-count ${id === 'commits' ? 'up' : ''}`}>{id === 'commits' ? <><ArrowUp size={9} />{count}</> : count}</span> : null}
          </button>
        ))}
      </div>
      {state.view === 'changes' ? (
        <ChangesView agentId={agent.id} base={base} status={status} state={state} />
      ) : state.view === 'commits' ? (
        <CommitsView agentId={agent.id} base={base} status={status} state={state} />
      ) : (
        <WorktreesView status={status} />
      )}
    </div>
  );
}
