import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/types';

/** GitHub rate-limits anonymous API calls; a few checks a day is plenty. */
const CHECK_INTERVAL = 4 * 60 * 60_000;
const FIRST_CHECK_DELAY = 15_000;

/**
 * Keeps the installed app current from the GitHub releases named by the
 * `publish` entry in electron-builder.yml. New versions download in the
 * background; installing waits for the user (or the next quit).
 */
export class UpdateService {
  onChanged: (status: UpdateStatus) => void = () => {};
  private current: UpdateStatus = { state: 'idle', version: null, percent: null, error: null, checkedAt: null };
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    if (!app.isPackaged) {
      this.current = { ...this.current, state: 'unsupported' };
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => {
      if (this.current.state !== 'ready' && this.current.state !== 'downloading') this.set({ state: 'checking', error: null });
    });
    autoUpdater.on('update-not-available', () => this.set({ state: 'current', version: null, percent: null, checkedAt: new Date().toISOString() }));
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0, checkedAt: new Date().toISOString() }));
    autoUpdater.on('download-progress', (progress) => this.set({ state: 'downloading', percent: progress.percent }));
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version, percent: 100 }));
    autoUpdater.on('error', (error) => {
      // A failed check keeps an already downloaded update installable.
      // Messages can carry a whole HTTP response; the first line says what went wrong.
      let message = (error?.message ?? String(error)).split('\n')[0].trim().slice(0, 200);
      if (/^\d{3}$/.test(message)) message = `GitHub answered HTTP ${message}.`;
      if (this.current.state !== 'ready') this.set({ state: 'error', percent: null, error: message });
    });
  }

  status(): UpdateStatus {
    return this.current;
  }

  start() {
    if (this.current.state === 'unsupported') return;
    setTimeout(() => this.check(), FIRST_CHECK_DELAY);
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL);
  }

  async check(): Promise<UpdateStatus> {
    if (this.current.state === 'unsupported' || this.current.state === 'downloading' || this.current.state === 'ready') return this.current;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Reported through the 'error' event.
    }
    return this.current;
  }

  /** Quits, installs silently and starts the new version. */
  install() {
    if (this.current.state !== 'ready') throw new Error('No update has been downloaded yet.');
    autoUpdater.quitAndInstall(true, true);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }

  private set(patch: Partial<UpdateStatus>) {
    this.current = { ...this.current, ...patch };
    this.onChanged(this.current);
  }
}
