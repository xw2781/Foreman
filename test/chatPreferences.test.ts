import { beforeEach, describe, expect, it } from 'vitest';
import { installAppZoom } from '../src/preload/zoom';
import { chatFontSize } from '../src/shared/appearance';
import { annotatedMessage, restoreAnnotations, setAnnotations, useAnnotations } from '../src/renderer/src/annotations';

function zoomWindow(saved?: string) {
  const target = new EventTarget();
  const storage = new Map(saved ? [['appZoomFactor', saved]] : []);
  Object.assign(target, { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  let factor = 1;
  installAppZoom(target as Window, { getZoomFactor: () => factor, setZoomFactor: (value) => { factor = value; } });
  const dispatch = (type: string, properties: object) => {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    target.dispatchEvent(event);
    return event;
  };
  return { factor: () => factor, storage, dispatch };
}

describe('app zoom gestures', () => {
  it('leaves ordinary scrolling alone and consumes Ctrl+wheel in both directions', () => {
    const app = zoomWindow();
    expect(app.dispatch('wheel', { ctrlKey: false, deltaY: -120 }).defaultPrevented).toBe(false);
    expect(app.factor()).toBe(1);
    expect(app.dispatch('wheel', { ctrlKey: true, deltaY: -120 }).defaultPrevented).toBe(true);
    expect(app.factor()).toBe(1.1);
    app.dispatch('wheel', { ctrlKey: true, deltaY: 120 });
    expect(app.factor()).toBe(1);
  });
  it('restores zoom, clamps repeated gestures, and persists Ctrl+0 reset', () => {
    const app = zoomWindow('1.5');
    expect(app.factor()).toBe(1.5);
    for (let i = 0; i < 40; i++) app.dispatch('wheel', { ctrlKey: true, deltaY: -120 });
    expect(app.factor()).toBe(2);
    for (let i = 0; i < 40; i++) app.dispatch('wheel', { ctrlKey: true, deltaY: 120 });
    expect(app.factor()).toBe(0.5);
    expect(app.dispatch('keydown', { ctrlKey: true, key: '0' }).defaultPrevented).toBe(true);
    expect(app.factor()).toBe(1);
    expect(app.storage.get('appZoomFactor')).toBe('1');
    expect(zoomWindow('invalid').factor()).toBe(1);
  });
});

it('handles old or invalid font settings and keeps text sizes bounded', () => {
  expect(chatFontSize(undefined)).toBe(13.5);
  expect(chatFontSize(NaN)).toBe(13.5);
  expect(chatFontSize(Infinity)).toBe(13.5);
  expect(chatFontSize(0)).toBe(10);
  expect(chatFontSize(50)).toBe(24);
  expect(chatFontSize(16.5)).toBe(16.5);
});

describe('annotation drafts', () => {
  beforeEach(() => useAnnotations.setState({ drafts: {} }));
  const quote = { id: 'quote-1', text: 'First line\nSecond line', comment: 'Please clarify.' };
  it('includes multiline quotes, comments and the follow-up in the sent text', () => {
    const message = annotatedMessage('Explain this', [quote]);
    expect(message).toContain('> First line\n> Second line');
    expect(message).toContain('Comment: Please clarify.');
    expect(message).toContain('Follow-up:\nExplain this');
    expect(annotatedMessage('/help', [])).toBe('/help');
    expect(annotatedMessage('', [quote])).not.toContain('Follow-up:');
  });
  it('keeps drafts isolated and restores failed sends alongside newly added quotes', () => {
    setAnnotations('a', [quote]);
    setAnnotations('b', [{ ...quote, id: 'other' }]);
    setAnnotations('a', []);
    setAnnotations('a', [{ ...quote, id: 'new' }]);
    restoreAnnotations('a', [quote]);
    restoreAnnotations('a', [quote]);
    expect(useAnnotations.getState().drafts.a.map((item) => item.id)).toEqual(['quote-1', 'new']);
    expect(useAnnotations.getState().drafts.b.map((item) => item.id)).toEqual(['other']);
  });
});
