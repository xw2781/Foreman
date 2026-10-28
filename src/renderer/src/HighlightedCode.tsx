import { memo, useMemo } from 'react';
import { highlightCode } from './syntax';
import './syntax.css';

export const HighlightedCode = memo(function HighlightedCode({ text, language }: { text: string; language?: string }) {
  const html = useMemo(() => highlightCode(text, language), [text, language]);
  return html === null ? <code className="syntax">{text}</code>
    : <code className="syntax" dangerouslySetInnerHTML={{ __html: html }} />;
});
