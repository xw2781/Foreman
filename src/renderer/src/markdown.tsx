import { memo, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, FolderOpen } from 'lucide-react';
import { call, errorMessage } from './api';
import { useApp } from './store';
import { chatLinkKind } from '@shared/chatLinks';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as any).props.children);
  return '';
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost sm icon copy-btn"
      title={copied ? 'Copied' : label}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function ChatLink({ href = '', children, agentId }: { href?: string; children: ReactNode; agentId?: string }) {
  const toast = useApp((state) => state.toast);
  const kind = chatLinkKind(href);
  const [busy, setBusy] = useState(false);
  const act = async (action: 'open' | 'show') => {
    if (busy) return;
    setBusy(true);
    try {
      if (kind === 'web') await call('shell.openExternal', href.startsWith('//') ? `https:${href}` : href);
      else if (kind === 'file' && agentId) await call('chat.file', agentId, href, action);
      else throw new Error(href.startsWith('sandbox:')
        ? 'This link points to a sandbox download, not a file on this computer. Ask the agent to save the file locally and share its full path.'
        : 'This link cannot be opened here. Ask the agent for a local file path or a web URL.');
    } catch (error) { toast('error', errorMessage(error)); }
    finally { setBusy(false); }
  };
  const local = kind === 'file';
  return <>
    <a href={kind === 'web' ? href : undefined} role="link" tabIndex={0}
      className={local ? 'md-file-link' : undefined}
      title={local ? `Open file: ${href}` : href || 'Unavailable link'} aria-disabled={busy}
      onClick={(event) => { event.preventDefault(); void act('open'); }}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void act('open'); } }}>
      {children}
    </a>
    {local && agentId ? <button type="button" className="md-file-reveal" title={`Show in folder: ${href}`} aria-label={`Show ${textOf(children) || href} in folder`} disabled={busy} onClick={() => void act('show')}><FolderOpen size={13} /></button> : null}
  </>;
}

const components: Components = {
  pre: ({ children }) => {
    const code = (children as any)?.props;
    const language = /language-([\w-]+)/.exec(code?.className ?? '')?.[1] ?? '';
    const text = textOf(code?.children).replace(/\n$/, '');
    return (
      <div className="md-code">
        <div className="md-code-head">
          <span>{language}</span>
          <CopyButton text={text} />
        </div>
        <pre>
          <code>{text}</code>
        </pre>
      </div>
    );
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <span className="muted">[{alt || 'image'}]</span>
};

const plugins = [remarkGfm];

/** Assistant text. Memoized: a streaming reply re-renders only the message that changed. */
export const Markdown = memo(function Markdown({ text, agentId }: { text: string; agentId?: string }) {
  const renderers = useMemo<Components>(() => ({ ...components, a: ({ href, children }) => <ChatLink href={href} agentId={agentId}>{children}</ChatLink> }), [agentId]);
  return (
    <div className="md selectable">
      <ReactMarkdown remarkPlugins={plugins} components={renderers} urlTransform={(url, key, node) => node.tagName === 'a' && key === 'href' ? url : ''}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
