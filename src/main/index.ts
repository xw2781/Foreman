import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, Notification, shell, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_MODES,
  LIVE_STATUSES,
  PROVIDERS,
  PROVIDER_LABEL,
  type AgentInfo,
  type AppSettings,
  type EnvironmentInfo
} from '../shared/types';
import type { EventMap, EventName, InvokeChannel, InvokeMap } from '../shared/ipc';
import { ProfileService } from './profiles';
import { PlanUsageClient } from './planUsage';
import { TelemetryClient } from './telemetry/client';
import { HookServer } from './hookServer';
import { ProcessMonitor, killTree } from './processMonitor';
import { AgentManager } from './agents';
import { ComputerUseService } from './computerUse';
import { forgetCli, locateCli } from './cliLocator';
import { logoutCommand } from './commands';
import { UpdateService } from './updater';
import { HOME, JsonStore, cleanEnv, exists, profilesRoot, run } from './util';

app.setAppUserModelId('com.agenttaskcenter.app');
if (process.env.ATC_CAPTURE_DIR) {
  // Off-screen capture runs while the display may be asleep: keep painting anyway.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}
// Development aid: a separate data folder (settings, agent history) and single-instance lock,
// so a test instance can run next to the one in use.
if (process.env.ATC_USER_DATA) app.setPath('userData', path.resolve(process.env.ATC_USER_DATA));
else adoptLegacyUserData();
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// The app was called Agent Task Center, and Electron names the data folder after the product.
// Move the old folder over once (before the single-instance lock creates the new one); if it
// is in use — the old version still running — keep using it where it is.
function adoptLegacyUserData() {
  const current = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'Agent Task Center');
  if (exists(current) || !exists(legacy)) return;
  try {
    fs.renameSync(legacy, current);
  } catch {
    app.setPath('userData', legacy);
  }
}

const userData = app.getPath('userData');
const DEFAULT_SETTINGS: AppSettings = {
  activeProfile: { claude: 'claude-default', codex: 'codex-default' },
  cliPath: { claude: '', codex: '' },
  defaultCwd: HOME,
  recentCwds: [],
  theme: 'dark',
  lightPalette: 'cream',
  terminalFontSize: 13,
  terminalFontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  notifyOnNeedsInput: true,
  notifyOnTurnComplete: true,
  confirmBeforeStop: true,
  claudeContextWindow: 1_000_000,
  contextWindowOverrides: {},
  usageDays: 30,
  codexNoDaemonForIsolated: true,
  shellForTerminals: 'powershell.exe',
  claudeStatusLine: true
};

const settingsStore = new JsonStore<AppSettings>(path.join(userData, 'settings.json'), DEFAULT_SETTINGS);
const windowStore = new JsonStore<{ bounds: Electron.Rectangle | null; maximized: boolean }>(
  path.join(userData, 'window.json'),
  { bounds: null, maximized: false }
);
const settings = () => settingsStore.data;

const skillSource = app.isPackaged
  ? path.join(process.resourcesPath, 'skills', 'computer-use')
  : path.join(app.getAppPath(), 'resources', 'skills', 'computer-use');

const profiles = new ProfileService(userData);
const telemetry = new TelemetryClient(__dirname, path.join(userData, 'usage-cache.json'));
const hooks = new HookServer(path.join(userData, 'agent-settings'));
const processes = new ProcessMonitor();
const computerUse = new ComputerUseService(exists(skillSource) ? skillSource : null);
const agents = new AgentManager({ profiles, telemetry, hooks, processes, settings, userDataDir: userData, appVersion: app.getVersion() });
const updates = new UpdateService();

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function emit<E extends EventName>(event: E, payload: EventMap[E]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, payload);
}

function toast(kind: 'info' | 'success' | 'error', message: string) {
  emit('toast', { kind, message });
}

// ---------------------------------------------------------------------------
// Wiring between services
// ---------------------------------------------------------------------------

profiles.runningCounter = (id) => agents.runningCount(id);
profiles.skillChecker = (profile) => computerUse.isInstalled(profile);
profiles.codexLimitsLoader = (profile) => telemetry.codexLimits({ id: profile.id, provider: profile.provider, configDir: profile.configDir });
const planUsage = new PlanUsageClient((url, init) => net.fetch(url, init));
profiles.liveLimitsLoader = (profile, force) => planUsage.load(profile, force);
profiles.onChanged = () => {
  emit('profiles', profiles.views(settings().activeProfile));
  configureTelemetry();
};

function configureTelemetry() {
  const s = settings();
  return telemetry.configure(
    profiles.list().map((p) => ({ id: p.id, provider: p.provider, configDir: p.configDir })),
    { claudeContextWindow: s.claudeContextWindow, contextWindowOverrides: s.contextWindowOverrides, usageDays: s.usageDays }
  );
}

telemetry.onProgress = (scanned) => emit('usage-progress', scanned);
agents.onData = (id, data, end) => emit('agent-data', { id, data, end });
agents.onChat = (id, items, reset) => emit('chat', { id, items, reset });
hooks.onStatusLine = (id, payload) => agents.handleStatusLine(id, payload);
agents.onChanged = (list) => {
  emit('agents', list);
  updateWindowTitle(list);
};
agents.onRememberCwd = (cwd) => {
  const recent = [cwd, ...settings().recentCwds.filter((c) => c.toLowerCase() !== cwd.toLowerCase())].slice(0, 12);
  settingsStore.update({ recentCwds: recent, defaultCwd: cwd });
  emit('settings', settings());
};
agents.onAttention = (info, reason) => notifyAttention(info, reason);
if (process.env.ATC_CAPTURE_DIR) {
  const hookLog = path.join(process.env.ATC_CAPTURE_DIR, 'hooks.log');
  agents.onHookEvent = (event) => {
    fs.mkdirSync(path.dirname(hookLog), { recursive: true });
    fs.appendFileSync(hookLog, `${new Date().toISOString()} ${event.agentId} ${event.name} ${event.payload.tool_name ?? event.payload.notification_type ?? event.payload.source ?? ''}\n`);
  };
}
updates.onChanged = (status) => emit('update', status);
computerUse.onChanged = (status) => {
  emit('computer-use', status);
  agents.setScreenDriver(computerUse.currentDriver());
};

function updateWindowTitle(list: AgentInfo[]) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const waiting = list.filter((a) => a.status === 'needs-input').length;
  const working = list.filter((a) => a.status === 'working').length;
  const parts = [waiting ? `${waiting} need input` : '', working ? `${working} working` : ''].filter(Boolean);
  mainWindow.setTitle(parts.length ? `Foreman — ${parts.join(', ')}` : 'Foreman');
}

function notifyAttention(info: AgentInfo, reason: 'needs-input' | 'turn-complete' | 'task-complete' | 'failed') {
  const s = settings();
  const wantsIt = reason === 'needs-input' ? s.notifyOnNeedsInput : s.notifyOnTurnComplete;
  const focused = mainWindow?.isFocused() ?? false;
  if (!wantsIt || focused || !Notification.isSupported()) {
    if (reason === 'needs-input' && !focused) mainWindow?.flashFrame(true);
    return;
  }
  const titles = {
    'needs-input': `${PROVIDER_LABEL[info.provider]} needs your input`,
    'turn-complete': `${PROVIDER_LABEL[info.provider]} finished its turn`,
    'task-complete': 'Background task complete',
    failed: 'Background task failed'
  };
  const notification = new Notification({
    title: titles[reason],
    body: `${info.title}${info.statusDetail && reason === 'needs-input' ? `\n${info.statusDetail}` : ''}`,
    silent: reason === 'turn-complete'
  });
  notification.on('click', () => {
    showWindow();
    emit('navigate', { view: 'agents', agentId: info.id });
  });
  notification.show();
  if (reason === 'needs-input') mainWindow?.flashFrame(true);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle<C extends InvokeChannel>(channel: C, fn: (...args: Parameters<InvokeMap[C]>) => ReturnType<InvokeMap[C]> | Promise<ReturnType<InvokeMap[C]>>) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as Parameters<InvokeMap[C]>));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });
}

const views = () => profiles.views(settings().activeProfile);

async function environment(): Promise<EnvironmentInfo> {
  const s = settings();
  const clis = await Promise.all(PROVIDERS.map((p) => locateCli(p, s.cliPath[p])));
  return {
    platform: process.platform,
    appVersion: app.getVersion(),
    userDataDir: userData,
    profilesDir: profilesRoot(),
    clis,
    hookServer: hooks.url
  };
}

function registerIpc() {
  handle('env.get', () => environment());
  handle('env.refreshClis', () => {
    forgetCli();
    return environment();
  });
  handle('settings.get', () => settings());
  handle('settings.update', async (patch) => {
    const next = settingsStore.update(patch);
    if (patch.cliPath) forgetCli();
    if ('claudeContextWindow' in patch || 'contextWindowOverrides' in patch || 'usageDays' in patch) await configureTelemetry();
    if (patch.activeProfile) emit('profiles', views());
    if (patch.theme || patch.lightPalette) applyTheme();
    emit('settings', next);
    return next;
  });
  handle('dialog.pickDirectory', async (defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], defaultPath: defaultPath || settings().defaultCwd });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('dialog.pickFile', async (title) => {
    const result = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('shell.openPath', async (target) => {
    await shell.openPath(target);
  });
  handle('shell.showItem', (target) => shell.showItemInFolder(target));
  handle('shell.openExternal', async (url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  handle('profiles.list', () => views());
  handle('profiles.create', (input) => {
    const profile = profiles.create(input);
    const primary = profiles.list().find((p) => p.builtin && p.provider === input.provider);
    if (primary && computerUse.isInstalled(primary) && !computerUse.isInstalled(profile)) {
      // Keep computer use available on the new account if the primary has it.
      try {
        computerUse.install(profile);
      } catch {
        // optional
      }
    }
    return views();
  });
  handle('profiles.update', (id, patch) => {
    profiles.update(id, patch);
    return views();
  });
  handle('profiles.remove', (id, deleteData) => {
    if (agents.runningCount(id) > 0) throw new Error('Stop this account\'s running agents first.');
    const profile = profiles.require(id);
    profiles.remove(id, deleteData);
    const active = settings().activeProfile;
    if (active[profile.provider] === id) {
      settingsStore.update({ activeProfile: { ...active, [profile.provider]: `${profile.provider}-default` } });
    }
    return views();
  });
  handle('profiles.setActive', (provider, id) => {
    const profile = profiles.require(id);
    if (profile.provider !== provider) throw new Error('Account/provider mismatch');
    settingsStore.update({ activeProfile: { ...settings().activeProfile, [provider]: id } });
    emit('settings', settings());
    return views();
  });
  handle('profiles.refresh', async () => {
    await profiles.refresh();
    return views();
  });
  handle('profiles.login', (id) => {
    const profile = profiles.require(id);
    return agents.launch({ provider: profile.provider, profileId: id, cwd: HOME, mode: 'login' });
  });
  handle('profiles.logout', async (id) => {
    const profile = profiles.require(id);
    const cli = await locateCli(profile.provider, settings().cliPath[profile.provider]);
    if (!cli.path) throw new Error(cli.error ?? 'CLI not found');
    const env = profiles.envFor(profile, cleanEnv());
    const result = cli.path.toLowerCase().endsWith('.cmd')
      ? await run('cmd.exe', ['/d', '/c', cli.path, ...logoutCommand(profile)], { env, timeout: 30_000 })
      : await run(cli.path, logoutCommand(profile), { env, timeout: 30_000 });
    await profiles.refresh([id]);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Sign-out failed');
    return views();
  });
  handle('profiles.setGlobalDefault', async (id) => {
    const profile = profiles.require(id);
    await profiles.setGlobalDefault(id);
    toast('success', `Other apps will use "${profile.label}" for ${PROVIDER_LABEL[profile.provider]} after they restart (VS Code, desktop apps, new terminals).`);
    return views();
  });
  handle('profiles.shareConfig', (id) => {
    const profile = profiles.require(id);
    if (profile.builtin) throw new Error('The primary account already uses the shared configuration.');
    profiles.shareFromDefault(profile.provider, profile.configDir);
    return views();
  });
  handle('profiles.openShell', (id, cwd) => agents.launchShell(id, cwd && exists(cwd) ? cwd : settings().defaultCwd || HOME));

  handle('agents.list', () => agents.list());
  handle('agents.launch', (options) => agents.launch(options));
  handle('agents.write', (id, data) => agents.write(id, data));
  handle('agents.resize', (id, cols, rows) => agents.resize(id, cols, rows));
  handle('agents.stop', (id) => agents.stop(id));
  handle('agents.remove', (id) => agents.remove(id));
  handle('agents.clearFinished', () => agents.clearFinished());
  handle('agents.rename', (id, title) => agents.rename(id, title));
  handle('agents.resume', (id, mode) => agents.resume(id, mode));
  handle('agents.buffer', (id) => agents.buffer(id));
  handle('chat.items', (id) => agents.chatItems(id));
  handle('chat.send', (id, text) => agents.chatSend(id, text));
  handle('chat.interrupt', (id) => agents.chatInterrupt(id));
  handle('chat.respond', (id, itemId, answer) => agents.chatRespond(id, itemId, answer));
  handle('chat.configure', (id, patch) => agents.chatConfigure(id, patch));
  ipcMain.on('agents.write', (_event, id: string, data: string) => agents.write(id, data));
  ipcMain.on('agents.resize', (_event, id: string, cols: number, rows: number) => agents.resize(id, cols, rows));

  handle('processes.external', () => (processes.lastSnapshotAt ? processes.externalAgents(agents.ownedPids()) : null));
  handle('processes.kill', async (pid) => {
    const external = processes.externalAgents(agents.ownedPids());
    if (!external.some((p) => p.pid === pid)) throw new Error('Only agent processes listed in the task manager can be ended here.');
    await killTree(pid);
    await processes.snapshot();
    emit('externals', processes.externalAgents(agents.ownedPids()));
  });

  handle('usage.report', async (force) => {
    const report = await telemetry.usageReport(Boolean(force));
    return report;
  });

  handle('computerUse.status', () => computerUse.status());
  handle('computerUse.command', (name) => computerUse.command(name));
  handle('computerUse.setPolicy', (policy) => computerUse.setPolicy(policy));
  handle('computerUse.install', (profileId, install) => {
    const profile = profiles.require(profileId);
    if (install) computerUse.install(profile);
    else computerUse.uninstall(profile);
    return views();
  });
  handle('computerUse.image', (file) => {
    const resolved = path.resolve(file);
    if (!resolved.toLowerCase().startsWith(path.resolve(computerUse.stateDir).toLowerCase())) return null;
    if (!exists(resolved)) return null;
    return `data:image/png;base64,${fs.readFileSync(resolved).toString('base64')}`;
  });

  handle('update.status', () => updates.status());
  handle('update.check', () => updates.check());
  handle('update.install', async () => {
    if (!(await confirmStopAgents('Stop agents and update'))) return;
    // Installing closes the window first; don't ask about running agents again.
    quitting = true;
    updates.install();
  });
}

// ---------------------------------------------------------------------------
// Background loops
// ---------------------------------------------------------------------------

let lastExternalKey = '';

function startLoops() {
  // Processes + agent telemetry: fast while agents run or the window is visible.
  const agentLoop = async () => {
    const live = agents.list().some((a) => LIVE_STATUSES.includes(a.status));
    const visible = mainWindow ? mainWindow.isVisible() && !mainWindow.isMinimized() : false;
    try {
      if (live || visible) {
        await processes.snapshot();
        const external = processes.externalAgents(agents.ownedPids());
        const key = JSON.stringify(external.map((e) => [e.pid, Math.round(e.cpuPercent), Math.round(e.memoryMB)]));
        if (key !== lastExternalKey) {
          lastExternalKey = key;
          emit('externals', external);
        }
      }
      await agents.tick();
    } catch {
      // keep looping
    }
    setTimeout(agentLoop, live || visible ? 2500 : 10_000);
  };
  setTimeout(agentLoop, 500);

  setInterval(() => computerUse.poll(), 1200);

  // Account identity and plan limits change rarely (limits refresh when an agent runs).
  setInterval(() => profiles.refresh().catch(() => {}), 3 * 60_000);

  // Usage totals: rescan periodically so the dashboard stays current.
  const usageLoop = async () => {
    try {
      const report = await telemetry.usageReport(false);
      emit('usage', report);
    } catch {
      // ignore
    }
    setTimeout(usageLoop, 90_000);
  };
  setTimeout(usageLoop, 3000);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** Native title-bar and window colors; they match --page in styles.css. */
function windowChrome() {
  if (nativeTheme.shouldUseDarkColors) return { page: '#0e1016', symbols: '#c9cfdb' };
  return settings().lightPalette === 'grey' ? { page: '#d7d9dd', symbols: '#343a46' } : { page: '#ebe6dc', symbols: '#3d3629' };
}

function applyTheme() {
  const theme = settings().theme;
  nativeTheme.themeSource = theme;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const chrome = windowChrome();
    try {
      mainWindow.setTitleBarOverlay({ color: chrome.page, symbolColor: chrome.symbols, height: 40 });
    } catch {
      // only on Windows with titleBarOverlay
    }
    mainWindow.setBackgroundColor(chrome.page);
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** How many agents quitting would stop, when the user wants to be asked first (else 0). */
function runningAgentsToConfirm() {
  if (!settings().confirmBeforeStop) return 0;
  return agents.list().filter((a) => LIVE_STATUSES.includes(a.status) && AGENT_MODES.includes(a.mode)).length;
}

async function confirmStopAgents(action: string) {
  const running = runningAgentsToConfirm();
  if (!running) return true;
  const choice = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    buttons: [action, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Agents are still running',
    message: `${running} agent${running === 1 ? ' is' : 's are'} still running.`,
    detail: 'Quitting stops them. Interactive sessions can be resumed later from the Task Manager.'
  });
  return choice.response === 0;
}

function boundsVisible(bounds: Electron.Rectangle) {
  return screen.getAllDisplays().some((d) => {
    const area = d.workArea;
    return bounds.x < area.x + area.width - 80 && bounds.x + bounds.width > area.x + 80 && bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 80;
  });
}

function createWindow() {
  nativeTheme.themeSource = settings().theme;
  const saved = windowStore.data.bounds;
  const chrome = windowChrome();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(saved && boundsVisible(saved) ? saved : {}),
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Foreman',
    backgroundColor: chrome.page,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.page, symbolColor: chrome.symbols, height: 40 },
    icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !process.env.ATC_CAPTURE_DIR
    }
  });
  if (windowStore.data.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    windowStore.update({ bounds: mainWindow.isMaximized() ? windowStore.data.bounds : mainWindow.getBounds(), maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false);
    profiles.refresh().catch(() => {});
  });

  // Links inside terminals and the UI open in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
  });

  mainWindow.on('close', async (event) => {
    if (quitting || !runningAgentsToConfirm()) return;
    event.preventDefault();
    if (await confirmStopAgents('Stop agents and quit')) {
      quitting = true;
      app.quit();
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.ATC_CAPTURE_DIR) captureViews(process.env.ATC_CAPTURE_DIR);
}

/**
 * Development aid: renders every view off-screen and saves a PNG of each, so
 * the UI can be checked even when the display is asleep or remote. Enabled
 * only by the ATC_CAPTURE_DIR environment variable.
 */
function captureViews(dir: string) {
  const views = (process.env.ATC_CAPTURE_VIEWS ?? 'agents,tasks,usage,accounts,computer,settings,launcher').split(',');
  // ATC_CAPTURE_SCRIPT: a JSON list of { js?, wait?, shot?, save? } steps run in the page, for
  // end-to-end checks; `save` writes the step's result (JSON) to that file in the capture folder.
  const script: Array<{ js?: string; wait?: number; shot?: string; save?: string }> = process.env.ATC_CAPTURE_SCRIPT
    ? JSON.parse(fs.readFileSync(process.env.ATC_CAPTURE_SCRIPT, 'utf8'))
    : views.map((view) => ({ js: `window.__atcDev && window.__atcDev(${JSON.stringify(view)})`, wait: 1800, shot: view }));
  mainWindow?.webContents.once('did-finish-load', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(Number(process.env.ATC_CAPTURE_DELAY ?? 6000));
    for (const step of script) {
      try {
        const result = step.js ? await mainWindow?.webContents.executeJavaScript(step.js) : undefined;
        if (step.save) fs.writeFileSync(path.join(dir, step.save), JSON.stringify(result ?? null, null, 2));
      } catch (error) {
        fs.appendFileSync(path.join(dir, 'errors.log'), `${step.js}: ${String(error)}\n`);
      }
      await wait(step.wait ?? 1000);
      if (step.shot) {
        const image = await mainWindow?.webContents.capturePage();
        if (image) fs.writeFileSync(path.join(dir, `${step.shot}.png`), image.toPNG());
      }
    }
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents.list(), null, 2));
    if (process.env.ATC_CAPTURE_EXIT !== '0') {
      quitting = true;
      app.quit();
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  try {
    await hooks.start();
  } catch (error) {
    // Without hooks, Claude status falls back to transcript telemetry.
    console.error('Hook server failed to start', error);
  }
  await configureTelemetry();
  registerIpc();
  createWindow();
  startLoops();
  updates.start();
  computerUse.refreshInstalled(profiles.list());
  computerUse.loadPolicyFromSkill().catch(() => {});
  profiles.refresh().catch(() => {});
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (event) => {
  if ((app as any).__cleanedUp) return;
  event.preventDefault();
  (app as any).__cleanedUp = true;
  (async () => {
    try {
      await agents.stopAll();
      settingsStore.flush();
      windowStore.flush();
      processes.dispose();
      updates.dispose();
      hooks.stop();
      await telemetry.dispose();
    } finally {
      app.exit(0);
    }
  })();
});

app.on('window-all-closed', () => app.quit());
