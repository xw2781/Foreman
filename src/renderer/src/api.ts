import type { AtcBridge, EventMap, EventName, InvokeChannel, InvokeMap, ThemePrefs } from '@shared/ipc';
import type { LightPalette } from '@shared/types';

declare global {
  interface Window {
    atc: AtcBridge;
  }
}

export function call<C extends InvokeChannel>(channel: C, ...args: Parameters<InvokeMap[C]>): Promise<ReturnType<InvokeMap[C]>> {
  return window.atc.invoke(channel, ...args);
}

export function listen<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void) {
  return window.atc.on(event, listener);
}

export function writeToAgent(id: string, data: string) {
  window.atc.send('agents.write', id, data);
}

export function resizeAgent(id: string, cols: number, rows: number) {
  window.atc.send('agents.resize', id, cols, rows);
}

/** Electron wraps thrown errors as "Error invoking remote method 'x': Error: message". */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** The `data-theme` for the page: dark, or the chosen light palette. */
export function pageTheme(prefs: ThemePrefs, systemDark: boolean): 'dark' | LightPalette {
  const mode = prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme;
  return mode === 'dark' ? 'dark' : prefs.lightPalette;
}
