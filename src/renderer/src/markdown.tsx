import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { call } from './api';

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

const components: Components = {
  // Links open in the user's browser, never inside the app.
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && /^https?:\/\//i.test(href)) call('shell.openExternal', href);
      }}
    >
      {children}
    </a>
  ),
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
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md selectable">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
