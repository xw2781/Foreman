import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ChatImage } from '@shared/types';

function ImagePreview({ image, onClose }: { image: ChatImage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const fit = natural.width && size.width ? Math.min(1, size.width / natural.width, size.height / natural.height) : 1;
  const changeZoom = (factor: number) => setZoom((value) => Math.max(1, Math.min(8, value * factor)));

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const resize = () => setSize({ width: Math.max(1, element.clientWidth - 32), height: Math.max(1, element.clientHeight - 32) });
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY) changeZoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, []);

  // Keep the image centered when changing magnification, with all edges reachable by scrolling.
  useLayoutEffect(() => {
    const element = viewport.current!;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  }, [zoom, fit, natural]);

  return createPortal(
    <dialog ref={dialog} className="image-preview" aria-label={`Preview: ${image.name}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25); }
        if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.25); }
        if (event.key === '0') { event.preventDefault(); setZoom(1); }
      }}>
      <div className="image-preview-toolbar">
        <span className="ellipsis image-preview-name" title={image.name}>{image.name}</span>
        <button type="button" className="btn ghost icon" aria-label="Zoom out" title="Zoom out (-)" disabled={zoom <= 1} onClick={() => changeZoom(1 / 1.25)}><ZoomOut size={18} /></button>
        <span className="image-preview-zoom" aria-live="polite" title="Magnification relative to fit">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn ghost icon" aria-label="Zoom in" title="Zoom in (+)" disabled={zoom >= 8} onClick={() => changeZoom(1.25)}><ZoomIn size={18} /></button>
        <button type="button" className="btn ghost icon" aria-label="Fit image" title="Fit image (0)" onClick={() => setZoom(1)}><Maximize size={18} /></button>
        <button type="button" className="btn ghost icon" aria-label="Close preview" title="Close (Esc)" autoFocus onClick={onClose}><X size={18} /></button>
      </div>
      <div ref={viewport} className="image-preview-viewport" style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
        onPointerDown={(event) => {
          if (event.button !== 0 || zoom <= 1) return;
          const element = event.currentTarget;
          drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
          element.setPointerCapture(event.pointerId);
          element.style.cursor = 'grabbing';
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onLostPointerCapture={(event) => { drag.current = null; event.currentTarget.style.cursor = zoom > 1 ? 'grab' : 'default'; }}>
        <div className="image-preview-canvas">
          <img src={image.dataUrl} alt={image.name} draggable={false}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            style={natural.width ? { width: natural.width * fit * zoom, height: natural.height * fit * zoom } : { visibility: 'hidden' }} />
        </div>
      </div>
      <div className="image-preview-hint">Scroll to zoom · Drag to pan · Esc to close</div>
    </dialog>, document.body
  );
}

export function ImageAttachments({ images, onRemove }: { images?: ChatImage[]; onRemove?: (index: number) => void }) {
  const [preview, setPreview] = useState<ChatImage | null>(null);
  if (!images?.length) return null;
  return <>
    <div className="chat-images">{images.map((image, index) => <div className="chat-image" key={index}>
      <button type="button" className="chat-image-open" aria-label={`Preview ${image.name}`} onClick={() => setPreview(image)}>
        <img src={image.dataUrl} alt={image.name} title={`Preview ${image.name}`} />
      </button>
      {onRemove ? <button type="button" className="chat-image-remove btn ghost sm icon" aria-label={`Remove ${image.name}`} onClick={() => onRemove(index)}><X size={13} /></button> : null}
    </div>)}</div>
    {preview ? <ImagePreview image={preview} onClose={() => setPreview(null)} /> : null}
  </>;
}
