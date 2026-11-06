import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { AtSign, Copy, FolderOpen } from 'lucide-react';
import { create } from 'zustand';
import { composerInsert, FILE_REF_TYPE, fileRef, formatRef } from './fileRefs';
import { call } from './api';
import { useApp } from './store';

interface Target {
  agentId: string;
  cwd: string;
  full: string;
  /** Gone from disk (deleted in the working tree), so it can't be revealed. */
  missing?: boolean;
}

const useFileMenu = create<{ open: (Target & { x: number; y: number }) | null }>(() => ({ open: null }));

/** Right-click menu and drag source for a file or folder row in the side panel. */
export function fileRowProps(target: Target) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      const ref = fileRef(target.cwd, target.full);
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(FILE_REF_TYPE, JSON.stringify({ agentId: target.agentId, full: target.full }));
      event.dataTransfer.setData('text/plain', formatRef(ref.relative));
    },
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      useFileMenu.setState({ open: { ...target, x: event.clientX, y: event.clientY } });
    }
  };
}

/** Puts a mention of `full` into the agent's message box. */
export function referenceInMessage(agentId: string, cwd: string, full: string) {
  const insert = composerInsert.get(agentId);
  if (insert) insert(formatRef(fileRef(cwd, full).relative));
  else useApp.getState().toast('error', 'Open the conversation to reference a file in it.');
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => useApp.getState().toast('success', `Copied ${text}`),
    () => useApp.getState().toast('error', "Couldn't copy to the clipboard.")
  );
}

/** The menu for whichever row was right-clicked; render once, in the side panel. */
export function FileMenuHost() {
  const open = useFileMenu((s) => s.open);
  return open ? <FileMenu target={open} onClose={() => useFileMenu.setState({ open: null })} /> : null;
}

function FileMenu({ target, onClose }: { target: Target & { x: number; y: number }; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: target.x, top: target.y });
  const ref = fileRef(target.cwd, target.full);
  const inside = ref.relative !== target.full;
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPlace({ left: Math.max(8, Math.min(target.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(target.y, window.innerHeight - height - 8)) });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [target]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const run = (action: () => void) => () => { onClose(); action(); };
  const items: Array<{ label: string; icon: typeof Copy; action: () => void; disabled?: boolean; title?: string } | 'sep'> = [
    { label: 'Reference in message', icon: AtSign, action: () => referenceInMessage(target.agentId, target.cwd, target.full) },
    'sep',
    { label: 'Copy relative path', icon: Copy, action: () => copy(ref.relative), disabled: !inside, title: inside ? ref.relative : "Outside the agent's folder" },
    { label: 'Copy full path', icon: Copy, action: () => copy(target.full), title: target.full },
    { label: 'Copy name', icon: Copy, action: () => copy(ref.name) },
    'sep',
    { label: 'Reveal in File Explorer', icon: FolderOpen, action: () => void call('shell.showItem', target.full).catch(() => {}), disabled: target.missing, title: target.missing ? 'Deleted from the working tree' : undefined }
  ];
  return createPortal(
    <div ref={menu} className="popover file-menu" role="menu" aria-label={`Actions for ${ref.name}`} style={place}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
      <div className="pop-title ellipsis" title={target.full}>{ref.name}</div>
      {items.map((item, i) => item === 'sep' ? <div key={i} className="file-menu-sep" role="separator" /> : (
        <button key={item.label} type="button" className="pop-item file-menu-item" role="menuitem" disabled={item.disabled} title={item.title} onClick={run(item.action)}>
          <item.icon size={14} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}
