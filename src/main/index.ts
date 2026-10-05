import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, Notification, safeStorage, session, shell, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import { chatFontSize } from '../shared/appearance';
import fs from 'node:fs';
import os from 'node:os';
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
import type { EventMap, EventName, InvokeChannel, InvokeMap, ThemePrefs } from '../shared/ipc';
import { ProfileService } from './profiles';
import { discoverModels } from './modelCatalog';
import { PlanUsageClient } from './planUsage';
import { TelemetryClient } from './telemetry/client';
import { loadPricingFile, seedPricingFile } from './telemetry/pricingFile';
import { HookServer } from './hookServer';
import { ProcessMonitor, killTree } from './processMonitor';
import { resolveChatFile } from './chat/fileLinks';
import { AgentManager } from './agents';
import { ComputerUseService } from './computerUse';
import { forgetCli, locateCli } from './cliLocator';
import { installCli, rollbackCli } from './cliInstall';
import { logoutCommand } from './commands';
import { UpdateService } from './updater';
import { GitHubSync } from './githubSync';
import { BrowserService } from './browser/browserService';
import { BrowserMcpServer } from './browser/mcpServer';
import { callTool } from './browser/tools';
import { HOME, JsonStore, cleanEnv, exists, profilesRoot, readJsonFile, run, writeJsonFileAtomic } from './util';

app.setAppUserModelId('com.agenttaskcenter.app');
// Corporate HTTPS proxies can negotiate HTTP/2 that Chromium rejects with
// ERR_HTTP2_INADEQUATE_TRANSPORT_SECURITY. Use HTTP/1.1 for Electron requests;
// HTTPS and normal certificate verification remain enabled.
app.commandLine.appendSwitch('disable-http2');
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
  chatFontSize: 13.5,
  terminalFontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  notifyOnNeedsInput: true,
  notifyOnTurnComplete: true,
  confirmBeforeStop: true,
  claudeContextWindow: 1_000_000,
  contextWindowOverrides: {},
  usageDays: 30,
  codexNoDaemonForIsolated: true,
  shellForTerminals: 'powershell.exe',
  claudeStatusLine: true,
  chatSendMode: 'steer',
  voiceModel: 'Xenova/whisper-base',
  browserEnabled: true,
  browserAutoApprove: true,
  browserProfile: 'shared',
  browserAutoOpen: true
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
// Editable model prices; the main process prices chat turns, the worker everything else.
const pricingPath = path.join(userData, 'pricing.json');
let pricing = loadPricingFile(pricingPath);
const machine = machineIdentity();
const telemetry = new TelemetryClient(__dirname, {
  cachePath: path.join(userData, 'usage-cache.json'),
  pricingPath,
  importedPath: path.join(userData, 'usage-imported.json'),
  machine,
  appVersion: app.getVersion()
});
const githubSync = new GitHubSync(path.join(userData, 'github-sync.json'), {
  fetch: (url, init) => net.fetch(url, init),
  secrets: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  },
  telemetry,
  machineId: machine.id,
  machineName: machine.name,
  openExternal: (url) => void shell.openExternal(url)
});
const hooks = new HookServer(path.join(userData, 'agent-settings'));
const processes = new ProcessMonitor();
const computerUse = new ComputerUseService(exists(skillSource) ? skillSource : null);
const browsers = new BrowserService({
  mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  settings,
  emit: (event, payload) => emit(event, payload),
  downloadsDir: path.join(userData, 'browser-downloads')
});
const browserMcp = new BrowserMcpServer((agentId, name, args) => callTool(browsers, agentId, name, args), path.join(userData, 'agent-mcp'), app.getVersion());
const agents = new AgentManager({
  profiles,
  telemetry,
  hooks,
  processes,
  settings,
  userDataDir: userData,
  appVersion: app.getVersion(),
  browserArgs: (agentId, provider) => {
    const s = settings();
    if (!s.browserEnabled || !browserMcp.running) return [];
    return provider === 'claude' ? browserMcp.claudeArgs(agentId, s.browserAutoApprove) : browserMcp.codexArgs(agentId, s.browserAutoApprove);
  }
});
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
profiles.modelsLoader = async (profile) => {
  const cli = await locateCli(profile.provider, settings().cliPath[profile.provider]);
  return cli.path ? discoverModels(profile.provider, cli.path, profiles.envFor(profile, cleanEnv())) : [];
};
const planUsage = new PlanUsageClient((url, init) => net.fetch(url, init));
profiles.liveLimitsLoader = (profile, force) => planUsage.load(profile, force);
profiles.onChanged = () => {
  emit('profiles', profiles.views(settings().activeProfile));
  configureTelemetry();
};

/** Tells this computer's usage apart from other computers' (imported or synced); kept for the life of the data folder. */
function machineIdentity() {
  const file = path.join(userData, 'machine.json');
  let id = readJsonFile<{ id?: string }>(file)?.id;
  if (!id) {
    id = randomUUID();
    writeJsonFileAtomic(file, { id });
  }
  return { id, name: os.hostname() };
}

function configureTelemetry() {
  const s = settings();
  return telemetry.configure(
    profiles.list().map((p) => ({
      id: p.id,
      provider: p.provider,
      configDir: p.configDir,
      label: p.label,
      email: profiles.identity(p.id)?.email ?? p.emailHint ?? null
    })),
    { claudeContextWindow: s.claudeContextWindow, contextWindowOverrides: s.contextWindowOverrides, usageDays: s.usageDays }
  );
}

telemetry.onProgress = (scanned) => emit('usage-progress', scanned);
githubSync.onChanged = (status) => emit('github', status);
githubSync.onImported = () => {
  telemetry.quickReport().then((report) => emit('usage', report)).catch(() => {});
};
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
agents.onRemoved = (ids) => {
  for (const id of ids) {
    browsers.close(id).catch(() => {});
    browserMcp.removeConfig(id);
  }
};
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
  for (const operation of ['cli.install', 'cli.rollback'] as const) {
    handle(operation, async (provider) => {
      if (!PROVIDERS.includes(provider)) throw new Error('Unknown tool.');
      if (operation === 'cli.install') await installCli(provider, (url, init) => net.fetch(url instanceof URL ? url.toString() : url, init));
      else await rollbackCli(provider);
      settingsStore.update({ cliPath: { ...settings().cliPath, [provider]: '' } });
      forgetCli(provider);
      emit('settings', settings());
      return environment();
    });
  }
  handle('env.get', () => environment());
  handle('env.refreshClis', () => {
    forgetCli();
    return environment();
  });
  handle('settings.get', () => settings());
  handle('settings.update', async (patch) => {
    if ('chatFontSize' in patch) patch = { ...patch, chatFontSize: chatFontSize(patch.chatFontSize) };
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
    await profiles.refresh(undefined, true);
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
  handle('chat.file', async (id, href, action) => {
    const agent = agents.get(id);
    if (!agent) throw new Error('This conversation is no longer available.');
    if (action !== 'open' && action !== 'show') throw new Error('Unknown file action.');
    const target = resolveChatFile(href, agent.cwd, os.homedir());
    try {
      await fs.promises.stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`File not found: ${target}. Ask the agent for its full local path.`);
      throw new Error(`Cannot access: ${target}. ${error instanceof Error ? error.message : String(error)}`);
    }
    if (action === 'show') shell.showItemInFolder(target);
    else {
      const error = await shell.openPath(target);
      if (error) throw new Error(`Could not open ${target}: ${error}. Try Show in folder.`);
    }
  });
  handle('chat.send', (id, text, mode, images) => agents.chatSend(id, text, mode, images));
  handle('chat.queued', (id, itemId, action) => agents.chatQueued(id, itemId, action));
  handle('chat.interrupt', (id) => agents.chatInterrupt(id));
  handle('chat.respond', (id, itemId, answer) => agents.chatRespond(id, itemId, answer));
  handle('chat.configure', (id, patch) => agents.chatConfigure(id, patch));
  handle('chat.commands', (id) => agents.chatCommands(id));
  ipcMain.on('agents.write', (_event, id: string, data: string) => agents.write(id, data));
  ipcMain.on('agents.resize', (_event, id: string, cols: number, rows: number) => agents.resize(id, cols, rows));
  ipcMain.on('theme.initial', (event) => {
    const { theme, lightPalette } = settings();
    event.returnValue = { theme, lightPalette } satisfies ThemePrefs;
  });

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
  handle('usage.export', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export usage',
      defaultPath: path.join(app.getPath('documents'), `foreman-usage-${machine.name.replace(/[^\w.-]+/g, '-')}-${stamp}.json`),
      filters: [{ name: 'Foreman usage', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return null;
    return telemetry.exportUsage(result.filePath);
  });
  handle('usage.import', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import usage',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Foreman usage', extensions: ['json'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const outcome = await telemetry.importUsageFiles(result.filePaths);
    emit('usage', await telemetry.quickReport());
    return outcome;
  });
  handle('usage.forgetMachine', async (id) => {
    await telemetry.forgetMachine(id);
    const report = await telemetry.quickReport();
    emit('usage', report);
    return report;
  });
  handle('github.status', () => githubSync.status());
  handle('github.connect', () => githubSync.connect());
  handle('github.cancel', () => {
    githubSync.cancel();
    return githubSync.status();
  });
  handle('github.disconnect', () => {
    githubSync.disconnect();
    return githubSync.status();
  });
  handle('github.sync', async () => {
    await githubSync.sync();
    return githubSync.status();
  });
  handle('pricing.status', () => pricing);
  handle('pricing.edit', async () => {
    seedPricingFile(pricingPath);
    await reloadPricing();
    const error = await shell.openPath(pricingPath);
    if (error) shell.showItemInFolder(pricingPath);
    return pricing;
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

  handle('browser.list', () => browsers.list());
  handle('browser.open', (agentId, url) => {
    if (!agents.get(agentId)) throw new Error('No such agent.');
    return browsers.open(agentId, url);
  });
  handle('browser.navigate', (agentId, url) => browsers.navigate(agentId, url));
  handle('browser.command', (agentId, command, tabId) => browsers.command(agentId, command, tabId));
  handle('browser.watch', (agentId) => browsers.watch(agentId));
  handle('browser.clearData', async () => {
    await browsers.clearData();
    toast('success', 'Cleared the agent browser: cookies, logins, storage and cache.');
  });
  ipcMain.on('browser.input', (event, agentId: string, input) => {
    if (event.sender === mainWindow?.webContents) browsers.input(agentId, input);
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

  // GitHub usage sync: shortly after start (the first scan has run by then), then every few hours.
  const syncLoop = async () => {
    if (githubSync.connected) await githubSync.sync().catch(() => {});
    setTimeout(syncLoop, 4 * 60 * 60_000);
  };
  setTimeout(syncLoop, 60_000);

  // An agent or the user may edit pricing.json at any time; polling survives editors that replace the file.
  fs.watchFile(pricingPath, { interval: 2000 }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) reloadPricing().catch(() => {});
  });
}

async function reloadPricing() {
  pricing = loadPricingFile(pricingPath);
  await telemetry.reloadPricing();
  emit('pricing', pricing);
  if (pricing.error) toast('error', pricing.error);
  emit('usage', await telemetry.usageReport(true));
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
  // ATC_CAPTURE_SCRIPT: a JSON list of { size?, js?, wait?, shot?, save? } steps run in the page, for
  // end-to-end checks; `size` ([width, height]) resizes the window first, to check narrow layouts;
  // `save` writes the step's result (JSON) to that file in the capture folder.
  const script: Array<{ size?: [number, number]; js?: string; wait?: number; shot?: string; save?: string }> = process.env.ATC_CAPTURE_SCRIPT
    ? JSON.parse(fs.readFileSync(process.env.ATC_CAPTURE_SCRIPT, 'utf8'))
    : views.map((view) => ({ js: `window.__atcDev && window.__atcDev(${JSON.stringify(view)})`, wait: 1800, shot: view }));
  mainWindow?.webContents.once('did-finish-load', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(Number(process.env.ATC_CAPTURE_DELAY ?? 6000));
    for (const step of script) {
      try {
        if (step.size) {
          mainWindow?.unmaximize();
          mainWindow?.setSize(step.size[0], step.size[1]);
        }
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
  try {
    await browserMcp.start();
  } catch (error) {
    // Agents then start without the browser tools.
    console.error('Browser tool server failed to start', error);
  }
  await configureTelemetry();
  // The app's own window may use the microphone (voice input); nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = permission === 'media' && !(details as any).mediaTypes?.some((t: string) => t !== 'audio');
    callback(audioOnly && contents === mainWindow?.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'media' && contents === mainWindow?.webContents);
  registerIpc();
  createWindow();
  startLoops();
  agents.reopenWarm().catch(() => {});
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
      browserMcp.stop();
      browsers.closeAll();
      await telemetry.dispose();
    } finally {
      app.exit(0);
    }
  })();
});

// Agent browser tabs are hidden windows: the app ends with its main window, not the last window.
app.on('window-all-closed', () => app.quit());
