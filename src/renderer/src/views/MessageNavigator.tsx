import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ChatItem } from '@shared/types';

type UserItem = Extract<ChatItem, { kind: 'user' }>;

/** The rail stays this short; with many messages the ticks close up instead. */
const RAIL_MAX = 0.5;
const TICK_SPACING = 9;

function preview(item: UserItem) {
  const text = item.text.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  return item.images?.length ? `[${item.images.length === 1 ? 'image' : `${item.images.length} images`}]` : '(empty)';
}

/** The element of a message in the conversation (`data-user-message` on its wrapper). */
function messageElement(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(`[data-user-message="${CSS.escape(id)}"]`);
}

/**
 * Every message the person sent, as ticks down the right edge of the conversation:
 * the one in view is marked, hovering lists them with a preview, and a click
 * scrolls back to the message.
 */
export function MessageNavigator({ messages, scrollRef }: { messages: UserItem[]; scrollRef: RefObject<HTMLDivElement | null> }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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

  // Keep the highlighted row of the open list in sight.
  const focus = hovered ?? current;
  useLayoutEffect(() => {
    if (!open || !focus) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, focus]);
  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  if (messages.length < 2) return null;

  const show = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };
  // A short grace period, so moving from the rail to the list doesn't close it.
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

  const spacing = Math.max(2, Math.min(TICK_SPACING, ((height || 400) * RAIL_MAX) / messages.length));
  return (
    <nav className={`msg-nav ${open ? 'open' : ''}`} aria-label="Your messages" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {open ? (
        <div className="msg-nav-list" ref={listRef} role="list">
          <div className="msg-nav-head">Your messages · {messages.length}</div>
          {messages.map((m, index) => (
            <button
              key={m.id}
              type="button"
              role="listitem"
              data-row={m.id}
              className={`msg-nav-row ${m.id === focus ? 'on' : ''} ${m.id === current ? 'current' : ''}`}
              onMouseEnter={() => setHovered(m.id)}
              onClick={() => go(m.id)}
            >
              <span className="msg-nav-index num">{index + 1}</span>
              <span className="msg-nav-text">{preview(m)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {/* Each tick's button is its whole slot, so even closely packed ticks are easy to hit. */}
      <div className="msg-nav-rail" style={{ ['--tick-line' as string]: `${spacing > 4 ? 2 : 1}px` }}>
        {messages.map((m) => (
          <button
            key={m.id}
            type="button"
            tabIndex={-1}
            aria-label={preview(m)}
            className={`msg-nav-tick ${m.id === current ? 'current' : ''} ${m.id === hovered ? 'hovered' : ''}`}
            style={{ height: spacing }}
            onMouseEnter={() => setHovered(m.id)}
            onClick={() => go(m.id)}
          />
        ))}
      </div>
    </nav>
  );
}
