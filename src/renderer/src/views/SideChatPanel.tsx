import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Eraser, LoaderCircle, MessageSquareDashed, RotateCcw } from 'lucide-react';
import { PROVIDER_LABEL, type AgentInfo } from '@shared/types';
import { CopyButton, Markdown } from '../markdown';
import { askSide, clearSide, NO_SIDE_MESSAGES, retrySide, sidePending, useSideChats } from '../sideChat';

/** Unsent side-chat text per agent. */
const sideDrafts = new Map<string, string>();

/**
 * Questions about the conversation that stay out of it: they don't interrupt or
 * steer the agent, and nothing here is added to its history or its context.
 */
export function SideChatPane({ agent }: { agent: AgentInfo }) {
  const messages = useSideChats((s) => s.chats[agent.id] ?? NO_SIDE_MESSAGES);
  const [text, setText] = useState(() => sideDrafts.get(agent.id) ?? '');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pending = sidePending(messages);
  const name = PROVIDER_LABEL[agent.provider];

  useEffect(() => {
    setText(sideDrafts.get(agent.id) ?? '');
    inputRef.current?.focus();
  }, [agent.id]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    if (value) sideDrafts.set(agent.id, value);
    else sideDrafts.delete(agent.id);
  };
  const send = () => {
    if (!text.trim() || pending) return;
    void askSide(agent.id, text);
    update('');
  };

  return (
    <div className="sp-pane side-chat" aria-label="Side chat">
      <div className="sp-bar">
        <span className="sp-bar-text ellipsis">Not added to the conversation</span>
        <button type="button" className="btn ghost sm icon" title="Clear the side chat" aria-label="Clear the side chat" disabled={!messages.length} onClick={() => clearSide(agent.id)}>
          <Eraser size={13} />
        </button>
      </div>
      <div className="side-chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="side-chat-empty">
            <MessageSquareDashed size={22} />
            <strong>Ask about this conversation</strong>
            <span>
              {name} answers with the whole conversation in view, but nothing here is added to it, so the agent's work isn't interrupted or steered.
            </span>
            <span className="muted">
              {agent.provider === 'claude'
                ? "Answers come from what's already in the conversation, without tools, and reuse its prompt cache."
                : 'Codex answers in a read-only copy of the thread: it may read files, but changes nothing.'}
            </span>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="side-chat-exchange">
              <div className="side-chat-q selectable">{m.question}</div>
              {m.answer !== null ? (
                <div className="side-chat-a">
                  <Markdown text={m.answer} agentId={agent.id} />
                  <div className="side-chat-actions">
                    <CopyButton text={m.answer} label="Copy answer" />
                  </div>
                </div>
              ) : m.error !== null ? (
                <div className="chat-notice error side-chat-error">
                  <span className="selectable">{m.error}</span>
                  <button type="button" className="btn ghost sm" disabled={pending} onClick={() => void retrySide(agent.id, m.id)}>
                    <RotateCcw size={12} /> Retry
                  </button>
                </div>
              ) : (
                <div className="side-chat-wait">
                  <LoaderCircle size={13} className="spin" /> {agent.endedAt ? `Starting ${name}…` : 'Thinking…'}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <form
        className="side-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          className="input"
          rows={1}
          value={text}
          placeholder={messages.length ? 'Ask a follow-up…' : 'Ask a side question…'}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" className="btn primary icon" title="Ask" aria-label="Ask" disabled={!text.trim() || pending}>
          {pending ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={15} />}
        </button>
      </form>
    </div>
  );
}
