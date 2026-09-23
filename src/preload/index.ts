import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_NAMES, INVOKE_CHANNELS, SEND_CHANNELS, type AtcBridge } from '../shared/ipc';

// Only the channels declared in shared/ipc.ts are reachable from the page.
const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const sendAllowed = new Set<string>(SEND_CHANNELS);
const eventsAllowed = new Set<string>(EVENT_NAMES);

const bridge: AtcBridge = {
  invoke: ((channel: string, ...args: unknown[]) => {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  }) as AtcBridge['invoke'],
  send(channel, ...args) {
    if (sendAllowed.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on(event, listener) {
    if (!eventsAllowed.has(event)) return () => {};
    const wrapped = (_: unknown, payload: any) => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  }
};

contextBridge.exposeInMainWorld('atc', bridge);
