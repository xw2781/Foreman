import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, File, FileCode2, FileImage, FileText, Folder, FolderOpen, FolderTree, LoaderCircle, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import { create } from 'zustand';
import type { AgentInfo, ProjectFileEntry, ProjectFilePreview } from '@shared/types';
import { call, errorMessage } from '../api';
import { Markdown } from '../markdown';
import { ago, folderName } from '../format';
import { Empty } from '../ui';
import { HighlightedCode } from '../HighlightedCode';
import { fileLanguage } from '../syntax';

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
  treeVisible: boolean;
  treeWidth: number;
  treeHeight: number;
}

const EMPTY: FilesState = { dirs: {}, open: { '': true }, selected: null, preview: null, source: false, treeVisible: false, treeWidth: 26, treeHeight: 25 };

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
  if (!quiet) patch(agentId, { selected: file, preview: 'loading', treeVisible: false });
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

function TextView({ text, file }: { text: string; file: string }) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return (
    <div className="fp-code">
      <pre className="fp-gutter" aria-hidden="true">{lines.map((_, i) => i + 1).join('\n')}</pre>
      <pre className="fp-text selectable"><HighlightedCode text={lines.join('\n')} language={fileLanguage(file)} /></pre>
    </div>
  );
}

function PreviewPane({ agent, state, expanded, onExpand }: { agent: AgentInfo; state: FilesState; expanded: boolean; onExpand?: () => void }) {
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
        <button type="button" className="btn ghost icon sm" aria-label="Show file tree" aria-pressed={state.treeVisible}
          title={state.treeVisible ? 'Hide file tree' : 'Show file tree'} onClick={() => patch(agent.id, { treeVisible: !state.treeVisible })}>
          <FolderTree size={14} />
        </button>
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
        {onExpand ? (
          <button type="button" className="btn ghost icon sm" aria-label={expanded ? 'Restore preview size' : 'Expand preview'}
            title={expanded ? 'Show the conversation too' : 'Expand preview'} onClick={onExpand}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        ) : null}
        <button className="btn ghost icon sm" aria-label="Open with the default app" title="Open with the default app" onClick={openFile}>
          <ExternalLink size={14} />
        </button>
        <button className="btn ghost icon sm" aria-label="Close the preview" title="Close the preview" onClick={() => patch(agent.id, { selected: null, preview: null, treeVisible: false })}>
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
              <TextView text={preview.text} file={file} />
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
export function FilesPanel({ agent, expanded, onExpand }: { agent: AgentInfo; expanded: boolean; onExpand?: () => void }) {
  const state = useFiles((s) => s[agent.id]) ?? EMPTY;
  const pane = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    const measure = () => setStacked(element.clientWidth <= 620);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
    <div ref={pane} className={`sp-pane files-pane ${state.selected ? 'previewing' : ''} ${state.treeVisible ? 'tree-visible' : ''} ${!expanded ? 'resizable' : ''}`}
      style={{ '--file-tree-width': `${state.treeWidth}%`, '--file-tree-height': `${state.treeHeight}%` } as CSSProperties}>
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
      {state.selected && state.treeVisible && !expanded ? (
        <div className="files-resize" role="separator" tabIndex={0} aria-label="Resize file preview"
          aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-valuemin={15} aria-valuemax={65}
          aria-valuenow={stacked ? state.treeHeight : state.treeWidth} title="Drag to resize; double-click to reset"
          onDoubleClick={() => patch(agent.id, { treeWidth: 26, treeHeight: 25 })}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId) || !pane.current) return;
            const bounds = pane.current.getBoundingClientRect();
            const share = stacked ? (event.clientY - bounds.top) / bounds.height : (event.clientX - bounds.left) / bounds.width;
            patch(agent.id, { [stacked ? 'treeHeight' : 'treeWidth']: Math.min(65, Math.max(15, share * 100)) });
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          onKeyDown={(event) => {
            const less = stacked ? 'ArrowUp' : 'ArrowLeft';
            const more = stacked ? 'ArrowDown' : 'ArrowRight';
            if (![less, more, 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = stacked ? state.treeHeight : state.treeWidth;
            const next = event.key === 'Home' ? 15 : event.key === 'End' ? 65 : current + (event.key === more ? 2 : -2);
            patch(agent.id, { [stacked ? 'treeHeight' : 'treeWidth']: Math.min(65, Math.max(15, next)) });
          }} />
      ) : null}
      {state.selected ? (
        <PreviewPane agent={agent} state={state} expanded={expanded} onExpand={onExpand} />
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
