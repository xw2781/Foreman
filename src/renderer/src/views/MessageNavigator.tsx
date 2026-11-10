import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { ChatItem } from '@shared/types';
import { parseAnnotatedMessage } from '../annotations';

type UserItem = Extract<ChatItem, { kind: 'user' }>;

/** The rail stays this short; with many messages the ticks close up instead. */
const RAIL_MAX = 0.5;
const TICK_SPACING = 9;

function preview(item: UserItem) {
  const quoted = parseAnnotatedMessage(item.text);
  const text = (quoted ? quoted.text || quoted.quotes.map((quote) => `“${quote.text}”`).join(' ') : item.text).replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  return item.images?.length ? `[${item.images.length === 1 ? 'image' : `${item.images.length} images`}]` : '(empty)';
}

/** The element of a message in the conversation (`data-user-message` on its wrapper). */
function messageElement(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(`[data-user-message="${CSS.escape(id)}"]`);
}

/**
 * Every message the person sent, as ticks down the right edge of the conversation:
 * the one in view is marked, hovering a tick previews that one message beside it,
 * and a click scrolls back to the message. Arrow keys move between ticks.
 */
export function MessageNavigator({ messages, scrollRef }: { messages: UserItem[]; scrollRef: RefObject<HTMLDivElement | null> }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  // The message in view: the last one whose top is above a third of the way down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = el.getBoundingClientRect().top + el.clientHeight / 3;
      let found: string | null = null;
      for (const node of el.querySelectorAll<HTMLElement>('[data-user-message]')) {
        if (node.getBoundingClientRect().top <= line) found = node.dataset.userMessage ?? null;
        else break;
      }
      setCurrent(found ?? messages[0]?.id ?? null);
      setHeight(el.clientHeight);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, messages]);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  if (messages.length < 2) return null;

  const show = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };
  // A short grace period, so moving from the rail to the preview doesn't close it.
  const hide = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setHovered(null);
    }, 180);
  };
  const go = (id: string) => {
    const el = scrollRef.current;
    const target = el && messageElement(el, id);
    if (!el || !target) return;
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16;
    el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    target.classList.remove('nav-flash');
    // Restart the animation when the same message is chosen twice.
    void target.offsetWidth;
    target.classList.add('nav-flash');
    window.setTimeout(() => target.classList.remove('nav-flash'), 1600);
    setCurrent(id);
  };

  const focus = hovered ?? current ?? messages[0].id;
  const focusIndex = Math.max(0, messages.findIndex((m) => m.id === focus));
  const focused = messages[focusIndex];
  const spacing = Math.max(2, Math.min(TICK_SPACING, ((height || 400) * RAIL_MAX) / messages.length));
  // Rail padding (6px) + the focused tick's centre: the preview sits level with it.
  const previewTop = 6 + focusIndex * spacing + spacing / 2;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : 0;
    if (!step) return;
    event.preventDefault();
    const next = messages[Math.max(0, Math.min(messages.length - 1, focusIndex + step))];
    setHovered(next.id);
    railRef.current?.querySelector<HTMLElement>(`[data-tick="${CSS.escape(next.id)}"]`)?.focus();
  };

  return (
    <nav className={`msg-nav ${open ? 'open' : ''}`} aria-label="Your messages" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {open && focused ? (
        <button type="button" className="msg-nav-preview" style={{ top: previewTop }} onClick={() => go(focused.id)} tabIndex={-1}>
          <span className={`msg-nav-index num ${focused.id === current ? 'current' : ''}`}>
            {focusIndex + 1} / {messages.length}
          </span>
          <span className="msg-nav-text">{preview(focused)}</span>
        </button>
      ) : null}
      {/* Each tick's button is its whole slot, so even closely packed ticks are easy to hit. */}
      <div className="msg-nav-rail" ref={railRef} onKeyDown={onKeyDown} style={{ ['--tick-line' as string]: `${spacing > 4 ? 2 : 1}px` }}>
        {messages.map((m) => (
          <button
            key={m.id}
            type="button"
            data-tick={m.id}
            tabIndex={m.id === focus ? 0 : -1}
            aria-label={preview(m)}
            className={`msg-nav-tick ${m.id === current ? 'current' : ''} ${m.id === hovered ? 'hovered' : ''}`}
            style={{ height: spacing }}
            onMouseEnter={() => setHovered(m.id)}
            onFocus={() => setHovered(m.id)}
            onClick={() => go(m.id)}
          />
        ))}
      </div>
    </nav>
  );
}
