import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, File, FileCode2, FileImage, FileText, Folder, FolderOpen, LoaderCircle, RotateCw, X } from 'lucide-react';
import { create } from 'zustand';
import type { AgentInfo, ProjectFileEntry, ProjectFilePreview } from '@shared/types';
import { call, errorMessage } from '../api';
import { Markdown } from '../markdown';
import { ago, folderName } from '../format';
import { Empty } from '../ui';

type Listing = { entries: ProjectFileEntry[]; omitted: number } | { error: string } | 'loading';
type Preview = ProjectFilePreview | { error: string; path: string } | 'loading';

interface FilesState {
  /** Loaded folders by relative path ('' is the project folder). */
  dirs: Record<string, Listing>;
  open: Record<string, boolean>;
  selected: string | null;
  preview: Preview | null;
  /** Markdown files show rendered unless the person asks for the source. */
  source: boolean;
}

const EMPTY: FilesState = { dirs: {}, open: { '': true }, selected: null, preview: null, source: false };

/** Each agent's tree and preview, kept while the panel shows another tab or another agent. */
const useFiles = create<Record<string, FilesState>>(() => ({}));

function patch(agentId: string, change: Partial<FilesState> | ((state: FilesState) => Partial<FilesState>)) {
  useFiles.setState((all) => {
    const current = all[agentId] ?? EMPTY;
    return { [agentId]: { ...current, ...(typeof change === 'function' ? change(current) : change) } };
  });
}

async function loadDir(agentId: string, dir: string) {
  patch(agentId, (s) => ({ dirs: { ...s.dirs, [dir]: s.dirs[dir] && s.dirs[dir] !== 'loading' ? s.dirs[dir] : 'loading' } }));
  let listing: Listing;
  try {
    listing = await call('files.list', agentId, dir);
  } catch (error) {
    listing = { error: errorMessage(error) };
  }
  patch(agentId, (s) => ({ dirs: { ...s.dirs, [dir]: listing } }));
}

async function loadPreview(agentId: string, file: string, quiet = false) {
  if (!quiet) patch(agentId, { selected: file, preview: 'loading' });
  let preview: Preview;
  try {
    preview = await call('files.read', agentId, file);
  } catch (error) {
    preview = { error: errorMessage(error), path: file };
  }
  // A reply for a file that's no longer selected is dropped.
  patch(agentId, (s) => (s.selected === file ? { preview } : {}));
}

/** Reloads the open folders and the previewed file, e.g. after the agent changed them. */
function refresh(agentId: string) {
  const state = useFiles.getState()[agentId] ?? EMPTY;
  for (const dir of Object.keys(state.dirs)) if (dir === '' || isShown(state, dir)) loadDir(agentId, dir);
  if (state.selected) loadPreview(agentId, state.selected, true);
}

/** A folder is shown when it and every folder above it are open. */
function isShown(state: FilesState, dir: string) {
  const parts = dir.split('/');
  return parts.every((_, i) => state.open[parts.slice(0, i + 1).join('/')]);
}

const CODE = /\.(c|cc|cpp|cs|css|go|h|hpp|html?|java|jsx?|json|kt|lua|mjs|cjs|php|ps1|py|rb|rs|scss|sh|sql|swift|toml|tsx?|vue|xml|ya?ml)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;

function FileIcon({ name }: { name: string }) {
  if (IMAGE.test(name)) return <FileImage size={14} />;
  if (CODE.test(name)) return <FileCode2 size={14} />;
  if (MARKDOWN.test(name) || /\.(txt|log|csv)$/i.test(name)) return <FileText size={14} />;
  return <File size={14} />;
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function absolute(agent: AgentInfo, relative: string) {
  const sep = agent.cwd.includes('\\') ? '\\' : '/';
  return relative ? `${agent.cwd.replace(/[\\/]+$/, '')}${sep}${relative.split('/').join(sep)}` : agent.cwd;
}

function FolderView({ agentId, dir, depth, state }: { agentId: string; dir: string; depth: number; state: FilesState }) {
  const listing = state.dirs[dir];
  if (!listing || listing === 'loading') {
    return (
      <div className="ft-note" style={{ paddingLeft: 10 + depth * 14 }}>
        <LoaderCircle size={12} className="spin" /> Loading…
      </div>
    );
  }
  if ('error' in listing) {
    return (
      <div className="ft-note error" style={{ paddingLeft: 10 + depth * 14 }} title={listing.error}>
        {listing.error}
      </div>
    );
  }
  if (!listing.entries.length) {
    return (
      <div className="ft-note" style={{ paddingLeft: 10 + depth * 14 }}>
        Empty folder
      </div>
    );
  }
  return (
    <>
      {listing.entries.map((entry) => {
        const open = Boolean(state.open[entry.path]);
        const toggle = () => {
          if (entry.dir) {
            patch(agentId, (s) => ({ open: { ...s.open, [entry.path]: !open } }));
            if (!open && !state.dirs[entry.path]) loadDir(agentId, entry.path);
          } else loadPreview(agentId, entry.path);
        };
        return (
          <div key={entry.path} role="treeitem" aria-expanded={entry.dir ? open : undefined} aria-selected={state.selected === entry.path}>
            <button
              type="button"
              className={`ft-row ${state.selected === entry.path ? 'on' : ''}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              title={entry.dir ? entry.path : `${entry.path}\n${size(entry.size)} · changed ${ago(new Date(entry.modifiedMs).toISOString())}`}
              onClick={toggle}
            >
              <span className="ft-chevron">{entry.dir ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
              <span className="ft-icon">{entry.dir ? open ? <FolderOpen size={14} /> : <Folder size={14} /> : <FileIcon name={entry.name} />}</span>
              <span className="ellipsis">{entry.name}</span>
            </button>
            {entry.dir && open ? <FolderView agentId={agentId} dir={entry.path} depth={depth + 1} state={state} /> : null}
          </div>
        );
      })}
      {listing.omitted ? (
        <div className="ft-note" style={{ paddingLeft: 10 + depth * 14 }}>
          {listing.omitted} more not shown
        </div>
      ) : null}
    </>
  );
}

function TextView({ text }: { text: string }) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return (
    <div className="fp-code">
      <pre className="fp-gutter" aria-hidden="true">{lines.map((_, i) => i + 1).join('\n')}</pre>
      <pre className="fp-text selectable">{lines.join('\n')}</pre>
    </div>
  );
}

function PreviewPane({ agent, state }: { agent: AgentInfo; state: FilesState }) {
  const preview = state.preview;
  const file = state.selected;
  if (!file || !preview) return null;
  const name = file.split('/').pop() ?? file;
  const markdown = MARKDOWN.test(name);
  const full = absolute(agent, file);
  const openFile = () => call('shell.openPath', full).catch(() => {});
  return (
    <div className="fp">
      <div className="sp-bar fp-head">
        <span className="ft-icon">
          <FileIcon name={name} />
        </span>
        <span className="fp-name ellipsis" title={full}>
          {file}
        </span>
        {preview !== 'loading' && !('error' in preview) ? <span className="muted fp-meta">{size(preview.size)}</span> : null}
        {markdown && preview !== 'loading' && !('error' in preview) && preview.kind === 'text' ? (
          <div className="segmented fp-mode">
            <button type="button" className={state.source ? '' : 'on'} onClick={() => patch(agent.id, { source: false })}>
              Preview
            </button>
            <button type="button" className={state.source ? 'on' : ''} onClick={() => patch(agent.id, { source: true })}>
              Source
            </button>
          </div>
        ) : null}
        <button className="btn ghost icon sm" title="Open with the default app" onClick={openFile}>
          <ExternalLink size={14} />
        </button>
        <button className="btn ghost icon sm" title="Close the preview" onClick={() => patch(agent.id, { selected: null, preview: null })}>
          <X size={14} />
        </button>
      </div>
      <div className="fp-body">
        {preview === 'loading' ? (
          <div className="ft-note">
            <LoaderCircle size={12} className="spin" /> Loading…
          </div>
        ) : 'error' in preview ? (
          <div className="ft-note error">{preview.error}</div>
        ) : preview.kind === 'image' ? (
          <div className="fp-image">
            <img src={preview.dataUrl} alt={name} />
          </div>
        ) : preview.kind === 'text' ? (
          <>
            {preview.truncated ? <div className="fp-notice">This file is {size(preview.size)}; only its beginning is shown.</div> : null}
            {markdown && !state.source ? (
              <div className="fp-markdown">
                <Markdown text={preview.text} agentId={agent.id} />
              </div>
            ) : (
              <TextView text={preview.text} />
            )}
          </>
        ) : (
          <div className="fp-other">
            <span className="muted">{preview.kind === 'binary' ? "This file isn't text, so it can't be previewed here." : 'This image is too large to preview here.'}</span>
            <button className="btn sm" onClick={openFile}>
              <ExternalLink size={13} /> Open with the default app
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The side panel's Files tab: the agent's project folder as a tree, with a preview of the chosen file. */
export function FilesPanel({ agent }: { agent: AgentInfo }) {
  const state = useFiles((s) => s[agent.id]) ?? EMPTY;
  const [spin, setSpin] = useState(false);
  useEffect(() => {
    if (!state.dirs['']) loadDir(agent.id, '');
  }, [agent.id]);
  // The agent likely changed files during its turn: reload once it settles.
  useEffect(() => {
    if (agent.status !== 'working' && useFiles.getState()[agent.id]?.dirs['']) refresh(agent.id);
  }, [agent.id, agent.status]);
  const reload = () => {
    setSpin(true);
    refresh(agent.id);
    setTimeout(() => setSpin(false), 400);
  };
  return (
    <div className={`sp-pane files-pane ${state.selected ? 'previewing' : ''}`}>
      <div className="ft">
        <div className="sp-bar">
          <span className="sp-bar-text ellipsis" title={agent.cwd}>
            {agent.projectless ? 'Chat files' : folderName(agent.cwd)}
          </span>
          <button className="btn ghost icon sm" title="Refresh" onClick={reload}>
            <RotateCw size={13} className={spin ? 'spin' : ''} />
          </button>
          <button className="btn ghost icon sm" title="Open the folder" onClick={() => call('shell.openPath', agent.cwd)}>
            <FolderOpen size={14} />
          </button>
        </div>
        <div className="ft-scroll" role="tree" aria-label="Project files">
          <FolderView agentId={agent.id} dir="" depth={0} state={state} />
        </div>
      </div>
      {state.selected ? (
        <PreviewPane agent={agent} state={state} />
      ) : (
        <div className="fp fp-placeholder">
          <Empty icon={<FileText size={22} />} title="No file selected">
            Choose a file to preview it.
          </Empty>
        </div>
      )}
    </div>
  );
}
