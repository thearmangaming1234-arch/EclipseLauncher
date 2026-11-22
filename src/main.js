const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const { Readable } = require('stream');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Client } = require('minecraft-launcher-core');
const extractZip = require('extract-zip');
const yauzl = require('yauzl');

const isDev = !app.isPackaged;
// app.getAppPath() points at the project root in development and the packaged
// app directory (often app.asar) after distribution. Never depend on cwd or a
// developer machine's checkout path for app resources.
const appRoot = app.getAppPath();
const sourceDirectory = path.join(appRoot, 'src');
const assetsDirectory = path.join(appRoot, 'assets');
const LAUNCHER_VERSION = app.getVersion();
const LAUNCHER_USER_AGENT = `EclipseLauncher/${LAUNCHER_VERSION}`;
const appIconPath = path.join(assetsDirectory, 'favicon.ico');
if (process.platform === 'win32') app.setAppUserModelId('com.eclipse.launcher');
// Keep development instances beside the project. Installed instances belong
// in userData, which remains writable regardless of where the app is installed.
const instancesDir = isDev
  ? path.join(appRoot, 'instances')
  : path.join(app.getPath('userData'), 'instances');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_BACKGROUND_NAME = 'Neon Eclipse Over Voxel Lakescape.png';
const defaultBackgroundSource = path.join(assetsDirectory, DEFAULT_BACKGROUND_NAME);
const defaultBackgroundPath = path.join(app.getPath('userData'), 'backgrounds', DEFAULT_BACKGROUND_NAME);
const launcherLogFile = path.join(app.getPath('userData'), 'logs', 'eclipse-launcher.log');
const launcherLogBackupFile = `${launcherLogFile}.1`;
const LAUNCHER_LOG_MAX_BYTES = 8 * 1024 * 1024;
const DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;
const fileVerificationCacheFile = path.join(app.getPath('userData'), 'file-verification-cache.json');
let lastUpdateProgressLog = -10;
let downloadedUpdateVersion = null;
const MINECRAFT_RSS_FEEDS = [
  { url: 'https://www.minecraft.net/en-us/feeds/community-content/rss', source: 'Minecraft.net' }
];
const NEWS_CACHE_MS = 10 * 60 * 1000;
const SKIN_URL_CACHE_MS = 15 * 60 * 1000;
let cachedMinecraftNews = null;
let cachedMinecraftNewsAt = 0;
let minecraftNewsRequest = null;
const skinUrlCache = new Map();
const INSTANCE_RELEASES = {
  '1.20.1-PVP': {
    url: 'https://github.com/thearmangaming1234-arch/StarEclipseLauncher/releases/download/PVPInstance/1.20.1-PVP.zip',
    launchProfile: 'fabric-loader-0.19.3-1.20.1',
    fabricLoader: '0.19.3',
    version: '1.20.1'
  },
  '26.2-Survival': {
    url: 'https://github.com/thearmangaming1234-arch/StarEclipseLauncher/releases/download/Instance/26.2.Survival.zip',
    launchProfile: 'fabric-loader-0.19.5-26.2',
    fabricLoader: '0.19.5',
    version: '26.2'
  }
};

function getInstanceRelease(folder, metadata = {}) {
  const releaseKey = typeof metadata.eclipseReleaseKey === 'string' ? metadata.eclipseReleaseKey : '';
  const officialRelease = INSTANCE_RELEASES[folder] || (releaseKey ? INSTANCE_RELEASES[releaseKey] : null);
  if (officialRelease) return officialRelease;
  return metadata.customInstance === true ? {
    version: metadata.version,
    loader: metadata.loader,
    launchProfile: metadata.launchProfile || ''
  } : null;
}
const activeInstanceInstalls = new Set();
const activeModInstalls = new Set();
const activeInstanceLaunches = new Map();
const pendingInstanceLaunches = new Set();
const MOJANG_RUNTIME_MANIFEST = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
let fileVerificationCache = null;
let fileVerificationCacheSaveTimer = null;

function appendLauncherLog(source, message) {
  try {
    fs.mkdirSync(path.dirname(launcherLogFile), { recursive: true });
    try {
      if (fs.statSync(launcherLogFile).size > LAUNCHER_LOG_MAX_BYTES) {
        try { fs.rmSync(launcherLogBackupFile, { force: true }); } catch {}
        fs.renameSync(launcherLogFile, launcherLogBackupFile);
      }
    } catch {}
    const timestamp = new Date().toISOString();
    const safeMessage = String(message || '').replace(/\0/g, '').slice(0, 30000);
    if (isBenignRuntimeNotice(safeMessage)) return;
    fs.appendFileSync(launcherLogFile, `[${timestamp}] [${source}] ${safeMessage}\n`, 'utf8');
  } catch {}
}

function isBenignRuntimeNotice(message) {
  return /(?:\[DEP0040\].*punycode|punycode.{0,120}deprecated|['"]console-message['"] arguments are deprecated|Electron Security Warning.*Insecure Content-Security-Policy)/i.test(String(message || ''));
}

for (const level of ['warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const message = args.map(value => value instanceof Error ? value.stack || value.message : typeof value === 'string' ? value : util.inspect(value, { depth: 3, breakLength: 140 })).join(' ');
    if (isBenignRuntimeNotice(message)) return;
    appendLauncherLog(`Launcher ${level}`, message);
    original(...args);
  };
}

process.on('uncaughtExceptionMonitor', error => appendLauncherLog('Launcher uncaught exception', error?.stack || error));

function runtimePlatform() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'windows-arm64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-os-arm64';
  if (process.platform === 'darwin') return 'mac-os';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux';
  throw new Error(`Automatic Java setup is not available for ${process.platform} ${process.arch}.`);
}

function runtimeDirectory(component, version) {
  return path.join(app.getPath('userData'), 'runtime', component, runtimePlatform(), version);
}

function runtimeJavaPath(component, version) {
  const runtimeRoot = runtimeDirectory(component, version);
  if (process.platform === 'darwin') return path.join(runtimeRoot, 'Contents', 'Home', 'bin', 'java');
  return path.join(runtimeRoot, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
}

function runtimeJavaProbePath(component, version) {
  if (process.platform !== 'win32') return runtimeJavaPath(component, version);
  return path.join(runtimeDirectory(component, version), 'bin', 'java.exe');
}

function hasSafeRuntimeMetadata(component, version) {
  return typeof component === 'string' && /^java-runtime-[a-z-]+$/.test(component) &&
    typeof version === 'string' && /^[a-zA-Z0-9._-]+$/.test(version);
}

function hasModJar(folder) {
  const modsPath = path.join(folder, 'mods');
  if (!fs.existsSync(modsPath) || !fs.statSync(modsPath).isDirectory()) return false;
  const scan = (directory, depth = 0) => {
    if (depth > 3) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.toLowerCase().endsWith('.jar') || entry.name.toLowerCase().endsWith('.jar.disabled'))) return true;
      if (entry.isDirectory() && scan(path.join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return scan(modsPath);
}

function hasContentFile(folder) {
  const scan = (directory, depth = 0) => {
    if (depth > 4) return false;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && scan(path.join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return fs.existsSync(folder) && fs.statSync(folder).isDirectory() && scan(folder);
}

function isInstanceInstalled(folder, metadata = {}) {
  const release = getInstanceRelease(folder, metadata);
  const profile = release || (metadata.customInstance === true ? {
    version: String(metadata.version || ''),
    loader: String(metadata.loader || 'Vanilla'),
    launchProfile: String(metadata.launchProfile || '')
  } : null);
  if (!profile) return false;
  if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(profile.version) ||
      (profile.launchProfile && !/^[A-Za-z0-9._-]+$/.test(profile.launchProfile))) return false;
  const instancePath = path.join(instancesDir, folder);
  const marker = path.join(instancePath, 'downloaded.txt');
  const mods = path.join(instancePath, 'mods');
  const config = path.join(instancePath, 'config');
  const runtimeComponent = metadata.runtimeComponent;
  const runtimeVersion = metadata.runtimeVersion;
  if (!hasSafeRuntimeMetadata(runtimeComponent, runtimeVersion)) return false;
  const java = runtimeJavaPath(runtimeComponent, runtimeVersion);
  const probeJava = runtimeJavaProbePath(runtimeComponent, runtimeVersion);
  let launchProfile = null;
  if (profile.launchProfile) {
    const profilePath = path.join(instancePath, 'versions', profile.launchProfile, `${profile.launchProfile}.json`);
    try { launchProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch { return false; }
  }
  let runtimeStamp;
  try { runtimeStamp = JSON.parse(fs.readFileSync(path.join(runtimeDirectory(runtimeComponent, runtimeVersion), '.eclipse-runtime-ready.json'), 'utf8')); } catch { return false; }
  if (!Array.isArray(runtimeStamp.files) || runtimeStamp.files.length === 0 || !runtimeStamp.files.every(file => {
    if (!file || typeof file.path !== 'string' || !Number.isFinite(file.size)) return false;
    const runtimeFile = path.resolve(runtimeDirectory(runtimeComponent, runtimeVersion), file.path.replace(/[\\/]/g, path.sep));
    if (!runtimeFile.startsWith(`${path.resolve(runtimeDirectory(runtimeComponent, runtimeVersion))}${path.sep}`)) return false;
    try {
      const stat = fs.statSync(runtimeFile);
      return stat.isFile() && stat.size === file.size;
    } catch { return false; }
  })) return false;
  const packReady = metadata.customInstance === true || (hasModJar(instancePath) && hasContentFile(config));
  const loader = String(metadata.loader || profile.loader || 'Fabric').toLowerCase();
  return fs.existsSync(marker) && fs.statSync(marker).isFile() && fs.existsSync(mods) && fs.statSync(mods).isDirectory() && packReady &&
    fs.existsSync(config) && fs.statSync(config).isDirectory() && fs.existsSync(java) && fs.existsSync(probeJava) &&
    (!profile.launchProfile || (launchProfile.id === profile.launchProfile && launchProfile.inheritsFrom === profile.version)) &&
    runtimeStamp.component === runtimeComponent && runtimeStamp.version === runtimeVersion &&
    ['fabric', 'vanilla', 'forge'].includes(loader) && String(metadata.version || profile.version) === profile.version &&
    (metadata.customInstance === true || loader === 'fabric');
}

function safeInstanceFolder(name) {
  const folder = String(name || '').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!folder) throw new Error('Choose an instance name with at least one letter or number.');
  return folder;
}

function getInstanceMetadata(folder) {
  if (typeof folder !== 'string' || !folder || path.basename(folder) !== folder) throw new Error('That Minecraft instance could not be found.');
  const instancePath = path.resolve(instancesDir, folder);
  if (path.dirname(instancePath) !== path.resolve(instancesDir)) throw new Error('That Minecraft instance path is invalid.');
  let info;
  try { info = fs.lstatSync(instancePath); } catch { throw new Error('That Minecraft instance could not be found.'); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('That Minecraft instance folder is invalid.');
  const metadataPath = path.join(instancePath, 'eclipse-instance.json');
  let metadata;
  try {
    const stat = fs.lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch { throw new Error('The instance profile file is missing or invalid.'); }
  return { instancePath, metadata };
}

function listDiagnosticLogs() {
  const logs = [];
  const add = (id, label, filePath, source, folder = '') => {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      logs.push({ id, label, source, folder, size: stat.size, modified: stat.mtime.toISOString() });
    } catch {}
  };
  add('launcher|current', 'Eclipse Launcher · Current log', launcherLogFile, 'launcher');
  add('launcher|previous', 'Eclipse Launcher · Previous log', launcherLogBackupFile, 'launcher');
  let entries = [];
  try { entries = fs.readdirSync(instancesDir, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let instancePath;
    let metadata;
    try { ({ instancePath, metadata } = getInstanceMetadata(entry.name)); } catch { continue; }
    const instanceName = String(metadata.name || entry.name);
    const logDirectory = path.join(instancePath, 'logs');
    add(`instance|${entry.name}|latest`, `${instanceName} · Minecraft latest.log`, path.join(logDirectory, 'latest.log'), 'minecraft', entry.name);
    add(`instance|${entry.name}|debug`, `${instanceName} · Minecraft debug.log`, path.join(logDirectory, 'debug.log'), 'minecraft', entry.name);
    const crashDirectory = path.join(instancePath, 'crash-reports');
    try {
      for (const crash of fs.readdirSync(crashDirectory, { withFileTypes: true })) {
        if (crash.isFile() && /^crash-.*\.txt$/i.test(crash.name)) {
          add(`instance|${entry.name}|crash|${crash.name}`, `${instanceName} · Crash report · ${crash.name}`, path.join(crashDirectory, crash.name), 'crash', entry.name);
        }
      }
    } catch {}
  }
  return logs.sort((a, b) => (a.source === 'launcher' ? 0 : 1) - (b.source === 'launcher' ? 0 : 1) || b.modified.localeCompare(a.modified));
}

function deleteDiagnosticCrashReport(id) {
  if (typeof id !== 'string' || id.length > 512) throw new Error('Choose a valid crash report.');
  const entry = listDiagnosticLogs().find(item => item.id === id);
  if (!entry || entry.source !== 'crash') throw new Error('Only Minecraft crash reports can be deleted here.');
  const [, folder, type, filename] = id.split('|');
  if (type !== 'crash' || !folder || !filename || path.basename(filename) !== filename || !/^crash-.*\.txt$/i.test(filename)) {
    throw new Error('That crash report could not be found.');
  }
  const { instancePath } = getInstanceMetadata(folder);
  const crashDirectory = path.join(instancePath, 'crash-reports');
  const directoryStat = fs.lstatSync(crashDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('That crash report folder is invalid.');
  const crashPath = path.join(crashDirectory, filename);
  const reportStat = fs.lstatSync(crashPath);
  if (!reportStat.isFile() || reportStat.isSymbolicLink()) throw new Error('That crash report is invalid.');
  fs.unlinkSync(crashPath);
  return { deleted: true };
}

function readDiagnosticLog(id) {
  if (typeof id !== 'string' || id.length > 512) throw new Error('Choose a valid log.');
  const entry = listDiagnosticLogs().find(item => item.id === id);
  if (!entry) throw new Error('That log could not be found. Refresh the log list and try again.');
  let filePath;
  if (id === 'launcher|current') filePath = launcherLogFile;
  else if (id === 'launcher|previous') filePath = launcherLogBackupFile;
  else {
    const [, folder, type, filename] = id.split('|');
    const { instancePath } = getInstanceMetadata(folder);
    if (type === 'latest' || type === 'debug') filePath = path.join(instancePath, 'logs', type === 'latest' ? 'latest.log' : 'debug.log');
    else if (type === 'crash' && filename && path.basename(filename) === filename && /^crash-.*\.txt$/i.test(filename)) filePath = path.join(instancePath, 'crash-reports', filename);
    else throw new Error('That log could not be found.');
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That log file is invalid.');
  const handle = fs.openSync(filePath, 'r');
  try {
    const bytesToRead = Math.min(stat.size, DIAGNOSTIC_LOG_MAX_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(handle, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
    let text = buffer.toString('utf8');
    if (entry.source === 'launcher') {
      text = text.split(/\r?\n/).filter(line => !isBenignRuntimeNotice(line)).join('\n');
    }
    return { ...entry, text, truncated: stat.size > bytesToRead };
  } finally { fs.closeSync(handle); }
}

function javaRuntimeComponent(majorVersion) {
  if (majorVersion >= 25) return 'java-runtime-epsilon';
  if (majorVersion >= 21) return 'java-runtime-delta';
  if (majorVersion >= 17) return 'java-runtime-gamma';
  if (majorVersion >= 16) return 'java-runtime-alpha';
  return 'java-runtime-legacy';
}

function sendInstallProgress(event, folder, progress) {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed()) return;
  sender.send('instance:install-progress', { folder, ...progress });
}

function sendLaunchStatus(event, folder, status) {
  if (!event.sender.isDestroyed()) event.sender.send('instance:launch-status', { folder, ...status });
}

function formatProcessExitCode(code) {
  if (!Number.isInteger(code)) return String(code);
  const unsigned = code >>> 0;
  const signed = unsigned >= 0x80000000 ? unsigned - 0x100000000 : unsigned;
  return signed < 0 ? `${signed} (0x${unsigned.toString(16).toUpperCase().padStart(8, '0')})` : String(signed);
}

function getFileVerificationCache() {
  if (fileVerificationCache) return fileVerificationCache;
  fileVerificationCache = new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(fileVerificationCacheFile, 'utf8'));
    for (const [key, value] of Object.entries(stored)) {
      if (value && Number.isFinite(value.size) && Number.isFinite(value.mtimeMs) && Number.isFinite(value.ctimeMs)) fileVerificationCache.set(key, value);
    }
  } catch {}
  return fileVerificationCache;
}

function saveFileVerificationCacheSoon() {
  clearTimeout(fileVerificationCacheSaveTimer);
  fileVerificationCacheSaveTimer = setTimeout(() => {
    try {
      const cache = getFileVerificationCache();
      while (cache.size > 50000) cache.delete(cache.keys().next().value);
      const temporaryPath = `${fileVerificationCacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(cache)));
      fs.renameSync(temporaryPath, fileVerificationCacheFile);
    } catch (error) {
      console.warn('[Minecraft] Could not save the local file verification cache:', error.message);
    }
  }, 800);
  fileVerificationCacheSaveTimer.unref?.();
}

function limitConcurrentWork(limit) {
  let active = 0;
  const waiting = [];
  return work => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        active--;
        waiting.shift()?.();
      });
    };
    if (active < limit) run();
    else waiting.push(run);
  });
}

function optimizeMinecraftFileChecks(handler, instanceRoot) {
  if (!handler || typeof handler.checkSum !== 'function') {
    console.warn('[Minecraft] Launcher checksum optimization is unavailable; continuing with the default file checks.');
    return;
  }
  const cache = getFileVerificationCache();
  const verifyLimited = limitConcurrentWork(4);
  const verifyOriginal = handler.checkSum.bind(handler);
  const libraryRoot = `${path.resolve(instanceRoot, 'libraries')}${path.sep}`;
  handler.checkSum = (hash, file) => {
    // MCLC calls checkSum for library JARs without awaiting or using its result. The files
    // are already existence-checked by MCLC, so hashing them here only adds disk contention.
    if (path.resolve(file).startsWith(libraryRoot)) return true;
    let stat;
    try { stat = fs.statSync(file); } catch { return verifyOriginal(hash, file); }
    const key = `${hash}:${path.resolve(file)}`;
    const cached = cache.get(key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return true;
    return verifyLimited(() => verifyOriginal(hash, file)).then(verified => {
      if (verified) {
        cache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
        saveFileVerificationCacheSoon();
      }
      return verified;
    });
  };
}

function configureLauncherHandler(launcher, javaProbePath, instanceRoot, strictDownloads = false, skipJavaProbe = false) {
  // minecraft-launcher-core creates its Handler inside launch(), immediately before
  // probing Java. Intercept that assignment so both customizations are installed before
  // its first checksum or Java-version check runs.
  let handlerInstance;
  Object.defineProperty(launcher, 'handler', {
    configurable: true,
    get() { return handlerInstance; },
    set(handler) {
      handlerInstance = handler;
      if (typeof handler?.checkJava === 'function') {
        const checkJava = handler.checkJava.bind(handler);
        // Installed runtimes are size-checked against Eclipse's ready manifest
        // before launch. Avoid starting a second JVM just to run `-version`.
        handler.checkJava = skipJavaProbe
          ? async () => fs.existsSync(javaProbePath) ? { run: true } : { run: false, message: 'The bundled Java runtime is missing.' }
          : () => checkJava(javaProbePath);
      }
      if (strictDownloads && typeof handler?.downloadAsync === 'function') {
        const downloadAsync = handler.downloadAsync.bind(handler);
        handler.downloadAsync = async (...args) => {
          const result = await downloadAsync(...args);
          if (!result || result.failed) throw new Error(`A required Minecraft file could not be downloaded: ${args[0]}`);
          return result;
        };
      }
      optimizeMinecraftFileChecks(handler, instanceRoot);
    }
  });
}

async function downloadMinecraftDependencies(event, folder, instancePath, metadata) {
  const runtimeComponent = metadata.runtimeComponent;
  const runtimeVersion = metadata.runtimeVersion;
  const javaProbePath = runtimeJavaProbePath(runtimeComponent, runtimeVersion);
  const launcher = new Client();
  configureLauncherHandler(launcher, javaProbePath, instancePath, true);

  let completedPreparation = false;
  let preparationError = '';
  let percent = 4;
  const stageFor = type => {
    const value = String(type || '').toLowerCase();
    if (value.includes('asset')) return { label: 'Minecraft assets', start: 58, end: 88 };
    if (value.includes('native')) return { label: 'Minecraft libraries', start: 18, end: 38 };
    if (value.includes('class') || value.includes('library')) return { label: 'Minecraft libraries', start: 38, end: 62 };
    if (value.includes('version') || value.includes('json')) return { label: 'Minecraft files', start: 8, end: 18 };
    return { label: 'Minecraft files', start: 8, end: 88 };
  };
  const report = (type, current, total) => {
    const stage = stageFor(type);
    const ratio = Number.isFinite(current) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(1, current / total))
      : 0;
    percent = Math.max(percent, Math.min(90, stage.start + ratio * (stage.end - stage.start)));
    sendInstallProgress(event, folder, {
      phase: 'dependencies',
      status: `Downloading ${stage.label}`,
      percent: Math.round(percent)
    });
  };

  launcher.on('download-status', status => report(status.type, status.current, status.total));
  launcher.on('progress', progress => report(progress.type, progress.task, progress.total));
  launcher.on('debug', message => {
    const match = String(message).match(/Failed to start due to (.*?), closing\.\.\.$/);
    if (match) preparationError = match[1];
  });
  // MCLC performs its regular version, library, native, and asset preparation
  // before startMinecraft. Replacing only that final step keeps installation from
  // opening the game while using the same dependency rules as a real launch.
  launcher.startMinecraft = () => {
    completedPreparation = true;
    return { prepared: true };
  };

  sendInstallProgress(event, folder, { phase: 'dependencies', status: 'Downloading Minecraft files', percent });
  const result = await launcher.launch({
    authorization: {
      access_token: '0',
      client_token: '',
      uuid: offlinePlayerUuid('Steve'),
      name: 'Steve',
      user_properties: '{}',
      meta: { type: 'legacy', demo: false }
    },
    root: instancePath,
    overrides: { maxSockets: 12 },
    version: {
      number: metadata.version,
      type: metadata.versionType || 'release',
      ...(metadata.launchProfile ? { custom: metadata.launchProfile } : {})
    },
    javaPath: runtimeJavaPath(runtimeComponent, runtimeVersion),
    memory: { min: '1G', max: '4G' }
  });
  if (!completedPreparation || !result?.prepared) {
    throw new Error(preparationError ? `Could not prepare Minecraft files: ${preparationError}` : 'Minecraft dependency preparation did not finish.');
  }
  sendInstallProgress(event, folder, { phase: 'dependencies', status: 'Minecraft files are ready', percent: 92 });
}

function createThrottledLaunchProgress(event, folder) {
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending) sendInstallProgress(event, folder, pending);
    pending = null;
  };
  return (progress, force = false) => {
    pending = progress;
    if (force) {
      clearTimeout(timer);
      flush();
    } else if (!timer) timer = setTimeout(flush, 180);
  };
}

function createLaunchProgressReporter(reportProgress) {
  const phases = [];
  let percent = 5;
  const phaseFor = type => {
    const value = String(type || '').toLowerCase();
    if (value.includes('assets-copy')) return 'assets-copy';
    if (value.startsWith('assets')) return 'assets';
    if (value.startsWith('classes')) return 'classes';
    if (value.includes('native')) return 'natives';
    return 'other';
  };
  const emit = force => reportProgress({
    kind: 'launch', phase: 'dependencies', status: 'Preparing Minecraft', percent: Math.round(percent)
  }, force);
  return {
    report(type, task, total, force = false) {
      const phase = phaseFor(type);
      if (!phases.includes(phase)) phases.push(phase);
      const index = phases.indexOf(phase);
      const ratio = Number.isFinite(task) && Number.isFinite(total) && total > 0
        ? Math.max(0, Math.min(1, task / total))
        : 0;
      // MCLC restarts each phase's counter at zero. Put each phase in its own
      // slice of one overall bar and keep the displayed value monotonic.
      percent = Math.max(percent, Math.min(80, 5 + index * 18 + ratio * 15));
      emit(force);
    },
    advance(target, force = false) {
      percent = Math.max(percent, Math.min(94, target));
      emit(force);
    }
  };
}

function offlinePlayerUuid(name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function copyMissingBundledFiles(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyMissingBundledFiles(sourcePath, destinationPath);
    else if (entry.isFile() && !fs.existsSync(destinationPath)) fs.copyFileSync(sourcePath, destinationPath);
  }
}

function collectStartupArchiveInputs(instanceRoot, javaPath, classpath) {
  const files = [];
  const addFile = filePath => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) files.push(`${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    } catch {}
  };
  for (const entry of classpath.split(path.delimiter)) addFile(entry);
  addFile(javaPath);

  const modsRoot = path.join(instanceRoot, 'mods');
  const scanMods = (directory, depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) scanMods(filePath, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) addFile(filePath);
    }
  };
  scanMods(modsRoot);
  return files.sort().join('\n');
}

function getStartupArchivePath(instanceRoot, javaPath, launchArguments, runtimeVersion, loader) {
  // Forge's JVM argument setup can run without a loaded base CDS archive;
  // Java then rejects DynamicDumpSharedSpaces from ArchiveClassesAtExit.
  // Leave Forge on the normal JVM startup path while retaining AppCDS for
  // Vanilla and Fabric, where the archive is supported.
  if (String(loader || '').toLowerCase() === 'forge') return null;
  const classpathIndex = launchArguments.findIndex(argument => argument === '-cp' || argument === '-classpath' || argument === '--class-path');
  const classpath = classpathIndex >= 0 ? launchArguments[classpathIndex + 1] : '';
  if (typeof classpath !== 'string' || !classpath) return null;
  const runtimeMajor = Number(String(runtimeVersion || '').match(/^\d+/)?.[0]);
  // Dynamic AppCDS is available from Java 13 onwards; older runtimes ignore it.
  if (Number.isFinite(runtimeMajor) && runtimeMajor > 0 && runtimeMajor < 13) return null;
  const inputs = collectStartupArchiveInputs(instanceRoot, javaPath, classpath);
  const signature = crypto.createHash('sha256').update(`${javaPath}\0${runtimeVersion}\0${classpath}\0${inputs}`).digest('hex').slice(0, 24);
  const archiveDirectory = path.join(app.getPath('userData'), 'startup-archives');
  fs.mkdirSync(archiveDirectory, { recursive: true });
  return path.join(archiveDirectory, `${path.basename(instanceRoot)}-${signature}.jsa`);
}

function getForgeJvmArguments(instanceRoot, profileId) {
  if (!profileId) return [];
  const profilePath = path.join(instanceRoot, 'versions', profileId, `${profileId}.json`);
  let profile;
  try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); }
  catch (error) { throw new Error(`Could not read Forge launch profile: ${error.message}`); }
  const source = Array.isArray(profile.arguments?.jvm) ? profile.arguments.jvm : [];
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const libraryDirectory = path.join(instanceRoot, 'libraries');
  const resolveArgument = value => String(value)
    .replaceAll('${library_directory}', libraryDirectory)
    .replaceAll('${classpath_separator}', path.delimiter)
    .replaceAll('${version_name}', profileId);
  const matchesRule = rule => {
    if (rule.os?.name && rule.os.name !== osName) return false;
    if (rule.os?.arch && rule.os.arch !== process.arch) return false;
    if (rule.os?.version && !new RegExp(rule.os.version).test(os.release())) return false;
    return true;
  };
  const output = [];
  for (const entry of source) {
    let values;
    if (typeof entry === 'string') values = [entry];
    else if (entry && typeof entry === 'object' && Array.isArray(entry.rules)) {
      let allowed = false;
      for (const rule of entry.rules) if (matchesRule(rule)) allowed = rule.action === 'allow';
      if (!allowed) continue;
      values = Array.isArray(entry.value) ? entry.value : [entry.value];
    } else continue;
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const resolved = resolveArgument(value);
      if (/\$\{[^}]+\}/.test(resolved)) throw new Error(`Forge launch profile contains an unsupported JVM argument: ${resolved}`);
      output.push(resolved);
    }
  }
  return output;
}

function updateInstanceMetadata(folder, update) {
  const metadataPath = path.join(instancesDir, folder, 'eclipse-instance.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  update(metadata);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return metadata;
}

function startInstancePlaytime(folder, onUpdate) {
  const startedAt = Date.now();
  let savedThrough = startedAt;
  let totalPlaytimeMs = 0;
  const initial = updateInstanceMetadata(folder, metadata => {
    metadata.playtimeMs = Number.isFinite(metadata.playtimeMs) ? Math.max(0, metadata.playtimeMs) : 0;
    metadata.lastPlayed = startedAt;
  });
  totalPlaytimeMs = initial.playtimeMs;
  const persistElapsed = () => {
    const now = Date.now();
    const elapsed = Math.max(0, now - savedThrough);
    if (!elapsed) return totalPlaytimeMs;
    const updated = updateInstanceMetadata(folder, metadata => {
      metadata.playtimeMs = (Number.isFinite(metadata.playtimeMs) ? Math.max(0, metadata.playtimeMs) : 0) + elapsed;
      metadata.lastPlayed = startedAt;
    });
    savedThrough = now;
    totalPlaytimeMs = updated.playtimeMs;
    onUpdate?.(updated.playtimeMs, startedAt);
    return updated.playtimeMs;
  };
  const timer = setInterval(() => {
    try { persistElapsed(); } catch (error) { console.warn('[Minecraft] Could not save instance playtime:', error.message); }
  }, 60000);
  timer.unref?.();
  return {
    startedAt,
    initialPlaytimeMs: initial.playtimeMs,
    persistElapsed,
    stop() {
      clearInterval(timer);
      try { return persistElapsed(); } catch (error) {
        console.warn('[Minecraft] Could not save final instance playtime:', error.message);
        return totalPlaytimeMs;
      }
    }
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
  if (!response.ok) throw new Error(`Could not retrieve installation metadata (${response.status}): ${url}`);
  return response.json();
}

async function downloadFile(url, destination, onProgress) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const meter = new (require('stream').Transform)({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      onProgress?.(received, total);
      callback(null, chunk);
    }
  });
  await require('stream/promises').pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination));
  return { received, total };
}

const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_USER_AGENT = `thearmangaming1234-arch/StarEclipseLauncher/${LAUNCHER_VERSION}`;
const MODRINTH_MAX_JAR_SIZE = 100 * 1024 * 1024;
const MODRINTH_MAX_ASSET_SIZE = 1024 * 1024 * 1024;
const MODRINTH_REGISTRY_NAME = '.eclipse-modrinth.json';
const modrinthAssetProjectCache = new Map();
const TL_SKIN_MOD_PAGE = 'https://www.9minecraft.net/tl-skin-and-cape-mod/';
const FABRIC_API_PROJECT_ID = 'P7dR8mSH';
const ECLIPSE_CUSTOMIZATION_MODS = [
  { id: 'Wq5SjeWM', slug: 'fancymenu', name: 'Eclipse Menu' },
  { id: 'DFqQfIBR', slug: 'craftpresence', name: 'Eclipse Discord Rich Presence' }
];
const ECLIPSE_CONFIG_ZIP_URL = 'https://github.com/thearmangaming1234-arch/StarEclipseLauncher/releases/download/config/config.zip';
const ECLIPSE_ESSENTIALS_PACK_URL = 'https://github.com/thearmangaming1234-arch/StarEclipseLauncher/releases/download/Eclipse-Pack/ECLIPSE.Essentials.zip';
const ECLIPSE_ESSENTIALS_PACK_FILE = 'ECLIPSE.Essentials.zip';
const eclipseCustomizationOptionsCache = new Map();
const TL_SKIN_ALLOWED_HOST = host => host === '9minecraft.net' || host.endsWith('.9minecraft.net')
  || host === 'cdn9mc.com' || host.endsWith('.cdn9mc.com')
  || host === '9sims4.com' || host.endsWith('.9sims4.com')
  // The 9Minecraft endpoints redirect signed JARs to rotating 9sims4.com hosts.
  || host === '9mcfiles.com' || host.endsWith('.9mcfiles.com');
const PERFORMANCE_MODS = [
  { id: 'AANobbMI', slug: 'sodium', name: 'Sodium' },
  { id: 'PtjYWJkn', slug: 'sodium-extra', name: 'Sodium Extra' },
  { id: 'Bh37bMuy', slug: 'reeses-sodium-options', name: "Reese's Sodium Options" },
  { id: 'LQ3K71Q1', slug: 'dynamic-fps', name: 'Dynamic FPS' },
  { id: 'iZ10HXDj', slug: 'fps-reducer', name: 'FPS Reducer' },
  { id: '5ZwdcRci', slug: 'immediatelyfast', name: 'ImmediatelyFast' },
  { id: 'NNAgCjsB', slug: 'entityculling', name: 'Entity Culling' },
  { id: 'gvQqBUqZ', slug: 'lithium', name: 'Lithium' },
  { id: 'Orvt0mRa', slug: 'indium', name: 'Indium' },
  { id: 'VSNURh3q', slug: 'c2me-fabric', name: 'C2ME' },
  { id: 'uXXizFIs', slug: 'ferrite-core', name: 'FerriteCore' },
  { id: 'nmDcB62a', slug: 'modernfix', name: 'ModernFix' },
  { id: 'YL57xq9U', slug: 'iris', name: 'Iris' },
  { id: 'fQEb0iXm', slug: 'krypton', name: 'Krypton' },
  { id: 'yHf7SALy', slug: 'fastanim', name: 'FastAnim' },
  { id: 'QdG47OkI', slug: 'modelfix', name: 'Model Gap Fix' },
  { id: 'wnEe9KBa', slug: 'vmp-fabric', name: 'Very Many Players' }
];
const UTILITY_MODS = [
  { id: 'EsAfCjCV', slug: 'appleskin', name: 'AppleSkin' },
  { id: 'n6PXGAoM', slug: 'better-stats', name: 'Better Statistics Screen' },
  { id: 'woulhAPh', slug: 'better-tab', name: 'BetterTab' },
  { id: '1IjD5062', slug: 'continuity', name: 'Continuity' },
  { id: 'uCdwusMi', slug: 'distanthorizons', name: 'Distant Horizons' },
  { id: 'mOgUt4GM', slug: 'modmenu', name: 'Mod Menu' },
  { id: 'w7ThoJFB', slug: 'zoomify', name: 'Zoomify' },
  { id: '2M01OLQq', slug: 'shulkerboxtooltip', name: 'Shulker Box Tooltip' }
];
let cachedOptiFineDownloadsPage = null;
let cachedOptiFineDownloadsPageAt = 0;
let optiFineDownloadsRequest = null;
let cachedTLSkinModPage = null;
let cachedTLSkinModPageAt = 0;
let tlSkinModPageRequest = null;

function hasInstalledModToggleMarkers(instancePath, modsPath, metadata) {
  if (!hasSafeRuntimeMetadata(metadata.runtimeComponent, metadata.runtimeVersion)) return false;
  try {
    const marker = fs.lstatSync(path.join(instancePath, 'downloaded.txt'));
    const mods = fs.lstatSync(modsPath);
    const runtimeReady = JSON.parse(fs.readFileSync(path.join(runtimeDirectory(metadata.runtimeComponent, metadata.runtimeVersion), '.eclipse-runtime-ready.json'), 'utf8'));
    return marker.isFile() && !marker.isSymbolicLink() && mods.isDirectory() && !mods.isSymbolicLink() &&
      runtimeReady.component === metadata.runtimeComponent && runtimeReady.version === metadata.runtimeVersion &&
      Array.isArray(runtimeReady.files) && runtimeReady.files.length > 0;
  } catch { return false; }
}

function getInstanceModContext(folder, requireInstalled = true, fastInstalledCheck = false) {
  if (typeof folder !== 'string' || path.basename(folder) !== folder) throw new Error('That Minecraft instance could not be found.');
  const instancePath = path.resolve(instancesDir, folder);
  if (path.dirname(instancePath) !== path.resolve(instancesDir)) throw new Error('That Minecraft instance path is invalid.');
  let instanceStat;
  try { instanceStat = fs.lstatSync(instancePath); } catch { throw new Error('That Minecraft instance could not be found.'); }
  if (!instanceStat.isDirectory() || instanceStat.isSymbolicLink()) throw new Error('That Minecraft instance folder is invalid.');
  let metadata = {};
  const metadataPath = path.join(instancePath, 'eclipse-instance.json');
  try {
    const metadataStat = fs.lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('The instance profile file is invalid.');
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }
  catch { throw new Error('The instance profile file is missing or invalid.'); }
  const release = getInstanceRelease(folder, metadata);
  if (!release) throw new Error('That Minecraft instance could not be found.');
  const installed = fastInstalledCheck
    ? hasInstalledModToggleMarkers(instancePath, path.join(instancePath, 'mods'), metadata)
    : isInstanceInstalled(folder, metadata);
  if (requireInstalled && !installed) throw new Error('This instance is not installed. Install it from Home before managing mods.');
  const modsPath = path.join(instancePath, 'mods');
  if (installed) {
    let stat;
    try { stat = fs.lstatSync(modsPath); } catch { throw new Error('The instance mods folder is missing.'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The instance mods folder is invalid.');
  }
  return { folder, instancePath, modsPath, metadata, release, installed };
}

function listJarFiles(modsPath) {
  if (!fs.existsSync(modsPath)) return [];
  return fs.readdirSync(modsPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && (entry.name.toLowerCase().endsWith('.jar') || entry.name.toLowerCase().endsWith('.jar.disabled')))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function baseJarName(fileName) {
  return fileName.toLowerCase().endsWith('.jar.disabled') ? fileName.slice(0, -'.disabled'.length) : fileName;
}

function normalizeModIdentity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.jar(?:\.disabled)?$/i, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/[0-9].*$/, '');
}

function modFilenameMatchesProject(fileName, project) {
  const stem = baseJarName(fileName).replace(/\.jar$/i, '');
  const fileWords = stem.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!fileWords.length) return false;
  const aliases = [project?.slug, project?.title, project?.name]
    .map(value => String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
    .filter(words => words.length);
  const loaderWords = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'mc', 'minecraft']);
  return aliases.some(alias => {
    if (alias.length > fileWords.length || !alias.every((word, index) => word === fileWords[index])) return false;
    if (alias.length === fileWords.length) return true;
    const nextWord = fileWords[alias.length];
    return loaderWords.has(nextWord) || /^\d/.test(nextWord);
  });
}

function ensureBuiltInModRecord(context) {
  let names = listJarFiles(context.modsPath).map(baseJarName);
  if (!Array.isArray(context.metadata.builtInMods)) {
    context.metadata.builtInMods = names;
    fs.writeFileSync(path.join(context.instancePath, 'eclipse-instance.json'), JSON.stringify(context.metadata, null, 2), 'utf8');
  } else {
    const present = new Set(names);
    const updated = context.metadata.builtInMods.filter(name => typeof name === 'string' && present.has(name));
    if (updated.length !== context.metadata.builtInMods.length) {
      context.metadata.builtInMods = updated;
      fs.writeFileSync(path.join(context.instancePath, 'eclipse-instance.json'), JSON.stringify(context.metadata, null, 2), 'utf8');
    }
  }
  return new Set(context.metadata.builtInMods);
}

function readModrinthRegistry(modsPath) {
  try {
    const filePath = path.join(modsPath, MODRINTH_REGISTRY_NAME);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return {};
    const registry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return registry && typeof registry === 'object' && !Array.isArray(registry) ? registry : {};
  } catch { return {}; }
}

function writeModrinthRegistry(modsPath, registry) {
  const filePath = path.join(modsPath, MODRINTH_REGISTRY_NAME);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The Eclipse mod registry file is invalid.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(registry, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally { fs.rmSync(temporaryPath, { force: true }); }
}

function readZipEntryBuffer(zip, entry, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) stream.destroy(new Error('Archive metadata is too large.'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function readModJarMetadata(filePath) {
  return new Promise(resolve => {
    let zipFile = null;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { zipFile?.close(); } catch {}
      resolve(result);
    };
    // Some third-party archives contain malformed ZIP directories or entries
    // that never finish streaming. Never let one archive hold the whole IPC call.
    const timeout = setTimeout(() => finish(null), 1800);
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (settled) { try { zip?.close(); } catch {} return; }
      if (openError || !zip) return finish(null);
      zipFile = zip;
      const entries = [];
      zip.on('entry', entry => {
        if (settled) return;
        if (!entry.fileName.endsWith('/')) entries.push(entry);
        zip.readEntry();
      });
      zip.once('error', () => finish(null));
      zip.once('end', async () => {
        if (settled) return;
        try {
          const fabricEntry = entries.find(entry => entry.fileName === 'fabric.mod.json');
          const quiltEntry = entries.find(entry => entry.fileName === 'quilt.mod.json');
          const tomlEntry = entries.find(entry => entry.fileName === 'META-INF/mods.toml');
          let data = null;
          if (fabricEntry || quiltEntry) {
            const raw = await readZipEntryBuffer(zip, fabricEntry || quiltEntry);
            data = JSON.parse(raw.toString('utf8'));
          }
          let id = data?.id || data?.quilt_loader?.id || '';
          let name = data?.name || data?.quilt_loader?.metadata?.name || '';
          let version = data?.version || data?.quilt_loader?.version || '';
          let description = data?.description || data?.quilt_loader?.metadata?.description || '';
          let iconPath = data?.icon || data?.quilt_loader?.metadata?.icon || '';
          if (iconPath && typeof iconPath === 'object') iconPath = Object.values(iconPath)[0] || '';
          if (!data && tomlEntry) {
            const toml = (await readZipEntryBuffer(zip, tomlEntry)).toString('utf8');
            id = toml.match(/^modId\s*=\s*["']([^"']+)/m)?.[1] || '';
            name = toml.match(/^displayName\s*=\s*["']([^"']+)/m)?.[1] || '';
            description = toml.match(/^description\s*=\s*["']([^"']+)/m)?.[1] || '';
          }
          let icon = '';
          if (typeof iconPath === 'string' && iconPath.length < 256 && !iconPath.startsWith('/') && !iconPath.split(/[\\/]/).includes('..')) {
            const iconEntry = entries.find(entry => entry.fileName === iconPath.replaceAll('\\', '/'));
            if (iconEntry && /\.(png|jpe?g)$/i.test(iconEntry.fileName)) {
              try {
                // Mod icons are decorative; keep the IPC response small even when a pack
                // contains oversized artwork for every bundled mod.
                const image = await readZipEntryBuffer(zip, iconEntry, 32 * 1024);
                const type = /\.jpe?g$/i.test(iconEntry.fileName) ? 'image/jpeg' : 'image/png';
                icon = `data:${type};base64,${image.toString('base64')}`;
              } catch { /* Keep the mod details and use the initials fallback. */ }
            }
          }
          finish({ id: String(id || ''), name: String(name || ''), version: String(version || ''), description: String(description || ''), icon });
        } catch { finish(null); }
      });
      zip.readEntry();
    });
  });
}

async function mapConcurrent(items, count, worker) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

async function listInstanceMods(folder, allowDuringInstall = false) {
  const context = getInstanceModContext(folder, false);
  const scanWhileInstalling = allowDuringInstall && activeInstanceInstalls.has(folder);
  if (!context.installed && !scanWhileInstalling) return { folder, installed: false, version: context.metadata.version || context.release.version, mods: [] };
  if (activeModInstalls.has(folder) && !allowDuringInstall) throw new Error('Wait for this instance’s mod installation to finish before managing its mods.');
  const builtIns = ensureBuiltInModRecord(context);
  const protectedBuiltIns = new Set(Array.isArray(context.metadata.eclipseCustomizationBuiltInMods) ? context.metadata.eclipseCustomizationBuiltInMods : []);
  const registry = readModrinthRegistry(context.modsPath);
  const fileNames = listJarFiles(context.modsPath);
  let iconBytes = 0;
  const mods = await mapConcurrent(fileNames, 4, async fileName => {
    const filePath = path.join(context.modsPath, fileName);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const baseName = baseJarName(fileName);
      const embedded = await readModJarMetadata(filePath) || {};
      const managed = registry[baseName] || {};
      let icon = embedded.icon || managed.icon || '';
      // A list of dozens of large base64 icons can exceed Chromium's IPC payload
      // budget. Keep just enough for useful thumbnails and fall back to initials.
      const bytes = icon.startsWith('data:') ? Math.ceil(icon.length * 0.75) : 0;
      if (iconBytes + bytes > 1024 * 1024) icon = '';
      else iconBytes += bytes;
      return {
        fileName,
        baseName,
        id: String(embedded.id || managed.modId || '').slice(0, 160),
        name: String(embedded.name || managed.name || baseName.replace(/\.jar$/i, '').replace(/[-_]+/g, ' ')).slice(0, 160),
        version: String(embedded.version || managed.version || '').slice(0, 100),
        modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
        description: String(embedded.description || managed.description || 'No description is available for this mod.').slice(0, 800),
        icon: icon.length <= 100_000 ? icon : '',
        builtIn: builtIns.has(baseName) || protectedBuiltIns.has(baseName),
        protectedBuiltIn: protectedBuiltIns.has(baseName),
        enabled: fileName.toLowerCase().endsWith('.jar'),
        modrinthProjectId: managed.projectId || '',
        modrinthSlug: managed.slug || ''
      };
    } catch {
      // One malformed archive or inaccessible file should not prevent the rest of
      // the instance's mods from appearing in the manager.
      return null;
    }
  });
  return { folder, installed: true, version: context.metadata.version || context.release.version, loader: context.metadata.loader || 'Fabric', mods: mods.filter(Boolean) };
}

async function openInstanceModsFolder(folder, assetType = 'mods') {
  const context = getInstanceModContext(folder, false);
  const directoryName = assetType === 'resourcepack' ? 'resourcepacks' : assetType === 'shader' ? 'shaderpacks' : 'mods';
  if (!['mods', 'resourcepack', 'shader'].includes(assetType)) throw new Error('That Minecraft folder type is not supported.');
  const targetPath = path.resolve(context.instancePath, directoryName);
  if (path.dirname(targetPath) !== path.resolve(context.instancePath)) throw new Error('That Minecraft folder path is invalid.');
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The selected mods folder is invalid.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(targetPath, { recursive: true });
  }
  const error = await shell.openPath(targetPath);
  if (error) throw new Error(`Could not open this instance’s ${directoryName} folder: ${error}`);
  return { opened: true };
}

function assertModFolderIdle(folder) {
  if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
    throw new Error('Close Minecraft and wait for any install or launch to finish before changing mods.');
  }
}

async function setInstanceModEnabled(folder, fileName, enabled) {
  assertModFolderIdle(folder);
  // The UI already has the mod inventory. A toggle only needs a safe in-place
  // rename; don't revalidate every runtime file or reopen every mod archive.
  const context = getInstanceModContext(folder, true, true);
  const expectedSuffix = enabled ? '.jar.disabled' : '.jar';
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith(expectedSuffix)) throw new Error('That mod file could not be found.');
  if (Array.isArray(context.metadata.eclipseCustomizationBuiltInMods) && context.metadata.eclipseCustomizationBuiltInMods.includes(baseJarName(fileName))) throw new Error('Eclipse customization mods cannot be disabled.');
  const source = path.resolve(context.modsPath, fileName);
  if (path.dirname(source) !== path.resolve(context.modsPath)) throw new Error('That mod file path is invalid.');
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That mod file is invalid.');
  const destinationName = enabled ? fileName.slice(0, -'.disabled'.length) : `${fileName}.disabled`;
  const destination = path.join(context.modsPath, destinationName);
  if (fs.existsSync(destination)) throw new Error('A mod with that filename already exists.');
  fs.renameSync(source, destination);
  return { folder, fileName: destinationName, enabled: Boolean(enabled) };
}

async function removeInstanceMod(folder, fileName) {
  assertModFolderIdle(folder);
  // Removal only mutates one file. Skip the full runtime validation and mod
  // archive metadata scan that are needed when refreshing the inventory.
  const context = getInstanceModContext(folder, true, true);
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !/\.jar(?:\.disabled)?$/i.test(fileName)) throw new Error('That mod file could not be found.');
  if (Array.isArray(context.metadata.eclipseCustomizationBuiltInMods) && context.metadata.eclipseCustomizationBuiltInMods.includes(baseJarName(fileName))) throw new Error('Eclipse customization mods cannot be removed.');
  const target = path.resolve(context.modsPath, fileName);
  if (path.dirname(target) !== path.resolve(context.modsPath)) throw new Error('That mod file path is invalid.');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That mod file is invalid.');
  const baseName = baseJarName(fileName);
  fs.unlinkSync(target);
  const missingBuiltInRecord = !Array.isArray(context.metadata.builtInMods);
  if (missingBuiltInRecord) context.metadata.builtInMods = listJarFiles(context.modsPath).map(baseJarName);
  const updatedBuiltIns = context.metadata.builtInMods.filter(name => name !== baseName);
  if (updatedBuiltIns.length !== context.metadata.builtInMods.length || missingBuiltInRecord) {
    context.metadata.builtInMods = updatedBuiltIns;
    fs.writeFileSync(path.join(context.instancePath, 'eclipse-instance.json'), JSON.stringify(context.metadata, null, 2), 'utf8');
  }
  const registry = readModrinthRegistry(context.modsPath);
  if (Object.prototype.hasOwnProperty.call(registry, baseName)) {
    delete registry[baseName];
    writeModrinthRegistry(context.modsPath, registry);
  }
  return { folder, fileName, removed: true };
}

function modrinthAssetType(value) {
  if (value === 'resourcepack' || value === 'shader') return value;
  throw new Error('Choose Resource Packs or Shaders.');
}

function getInstanceAssetDirectory(context, assetType, create = false) {
  const directoryName = assetType === 'resourcepack' ? 'resourcepacks' : assetType === 'shader' ? 'shaderpacks' : '';
  if (!directoryName) throw new Error('That Minecraft asset type is not supported.');
  const target = path.resolve(context.instancePath, directoryName);
  if (path.dirname(target) !== path.resolve(context.instancePath)) throw new Error('That asset folder path is invalid.');
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('That asset folder is invalid.');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) {
      if (error.code === 'ENOENT' && !create) return null;
      throw error;
    }
    fs.mkdirSync(target, { recursive: false });
  }
  return target;
}

function readModrinthAssetRegistry(assetDirectory) {
  const registryPath = path.join(assetDirectory, '.eclipse-modrinth-assets.json');
  try {
    const stat = fs.lstatSync(registryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return {};
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return registry && typeof registry === 'object' && !Array.isArray(registry) ? registry : {};
  } catch { return {}; }
}

function writeModrinthAssetRegistry(assetDirectory, registry) {
  const registryPath = path.join(assetDirectory, '.eclipse-modrinth-assets.json');
  const temporaryPath = `${registryPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(registry, null, 2), { flag: 'wx' });
    fs.renameSync(temporaryPath, registryPath);
  } finally { fs.rmSync(temporaryPath, { force: true }); }
}

function isMinecraftAssetDirectory(directory, assetType) {
  const marker = assetType === 'resourcepack' ? path.join(directory, 'pack.mcmeta') : path.join(directory, 'shaders');
  try {
    const stat = fs.lstatSync(marker);
    return assetType === 'resourcepack' ? stat.isFile() && !stat.isSymbolicLink() : stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

function plainMinecraftPackDescription(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plainMinecraftPackDescription).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  const ownText = typeof value.text === 'string' ? value.text : typeof value.translate === 'string' ? value.translate : '';
  return `${ownText}${plainMinecraftPackDescription(value.extra || '')}${plainMinecraftPackDescription(value.with || '')}`;
}

function parseMinecraftPackDescription(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    const description = plainMinecraftPackDescription(parsed?.pack?.description || '');
    return String(description).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 1200);
  } catch { return ''; }
}

function pngDataUrl(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > 5 * 1024 * 1024 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return '';
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16 * 1024 * 1024) return '';
  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return '';
    const scale = Math.min(1, 256 / Math.max(width, height));
    const preview = scale < 1
      ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }).toPNG()
      : image.toPNG();
    return `data:image/png;base64,${preview.toString('base64')}`;
  } catch { return ''; }
}

function readBoundedAssetFile(directory, name, maxBytes) {
  const filePath = path.resolve(directory, name);
  if (path.dirname(filePath) !== path.resolve(directory)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return fs.readFileSync(filePath);
  } catch { return null; }
}

async function readDirectoryAssetMetadata(directory, assetType) {
  const mcMeta = assetType === 'resourcepack' ? readBoundedAssetFile(directory, 'pack.mcmeta', 64 * 1024) : null;
  const imageNames = assetType === 'resourcepack' ? ['pack.png'] : ['icon.png', 'preview.png', 'pack.png'];
  let icon = '';
  for (const name of imageNames) {
    const image = readBoundedAssetFile(directory, name, 5 * 1024 * 1024);
    if (image && (icon = pngDataUrl(image))) break;
  }
  let description = mcMeta ? parseMinecraftPackDescription(mcMeta) : '';
  if (assetType === 'shader' && !description) {
    const properties = readBoundedAssetFile(directory, 'shaders.properties', 64 * 1024)?.toString('utf8') || '';
    description = /^\s*#\s*description\s*[:=]\s*(.+)$/im.exec(properties)?.[1]?.trim().slice(0, 1200) || '';
  }
  return { icon, description };
}

async function readZipAssetMetadata(filePath, assetType) {
  return new Promise(resolve => {
    let zip = null;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { zip?.close(); } catch {}
      resolve(value || { icon: '', description: '' });
    };
    const timeout = setTimeout(() => finish(null), 5000);
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, openedZip) => {
      if (settled) { try { openedZip?.close(); } catch {} return; }
      if (error || !openedZip) return finish(null);
      zip = openedZip;
      const entries = [];
      const candidateNames = new Set(assetType === 'resourcepack'
        ? ['pack.png', 'pack.mcmeta']
        : ['icon.png', 'preview.png', 'pack.png', 'shaders.properties']);
      zip.on('entry', entry => {
        if (settled) return;
        const parts = entry.fileName.replace(/\\/g, '/').split('/');
        if (parts.length <= 2 && candidateNames.has(parts.at(-1).toLowerCase()) && entry.uncompressedSize <= 5 * 1024 * 1024) entries.push(entry);
        zip.readEntry();
      });
      zip.once('error', () => finish(null));
      zip.once('end', async () => {
        if (settled) return;
        try {
          const findRootOrWrappedEntry = names => {
            for (const name of names) {
              const root = entries.find(entry => entry.fileName.replace(/\\/g, '/').toLowerCase() === name);
              if (root) return root;
            }
            for (const name of names) {
              const wrapped = entries.find(entry => {
                const parts = entry.fileName.replace(/\\/g, '/').split('/');
                return parts.length === 2 && parts[1].toLowerCase() === name;
              });
              if (wrapped) return wrapped;
            }
            return null;
          };
          const metaEntry = assetType === 'resourcepack' ? findRootOrWrappedEntry(['pack.mcmeta']) : null;
          const shaderPropertiesEntry = assetType === 'shader' ? findRootOrWrappedEntry(['shaders.properties']) : null;
          const imageNames = assetType === 'resourcepack' ? ['pack.png'] : ['icon.png', 'preview.png', 'pack.png'];
          let icon = '';
          for (const imageName of imageNames) {
            const imageEntry = findRootOrWrappedEntry([imageName]);
            if (!imageEntry || !/\.png$/i.test(imageEntry.fileName)) continue;
            try {
              icon = pngDataUrl(await readZipEntryBuffer(zip, imageEntry, 5 * 1024 * 1024));
              if (icon) break;
            } catch {}
          }
          let description = '';
          if (metaEntry) {
            try { description = parseMinecraftPackDescription(await readZipEntryBuffer(zip, metaEntry, 64 * 1024)); } catch {}
          } else if (shaderPropertiesEntry) {
            try {
              const properties = (await readZipEntryBuffer(zip, shaderPropertiesEntry, 64 * 1024)).toString('utf8');
              description = /^\s*#\s*description\s*[:=]\s*(.+)$/im.exec(properties)?.[1]?.trim().slice(0, 1200) || '';
            } catch {}
          }
          finish({ icon, description });
        } catch { finish(null); }
      });
      zip.readEntry();
    });
  });
}

async function getModrinthAssetProject(projectId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(projectId || ''))) return null;
  if (!modrinthAssetProjectCache.has(projectId)) {
    modrinthAssetProjectCache.set(projectId, modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`).catch(() => null));
  }
  return modrinthAssetProjectCache.get(projectId);
}

async function listInstanceAssets(folder, assetType) {
  const selectedType = modrinthAssetType(assetType);
  const context = getInstanceModContext(folder, false);
  if (!context.installed) return { folder, assetType: selectedType, installed: false, assets: [] };
  if (activeModInstalls.has(folder)) throw new Error('Wait for the current asset installation to finish before refreshing this list.');
  const assetDirectory = getInstanceAssetDirectory(context, selectedType);
  if (!assetDirectory) return { folder, assetType: selectedType, installed: true, assets: [] };
  const registry = readModrinthAssetRegistry(assetDirectory);
  const builtInResourcePacks = selectedType === 'resourcepack' && Array.isArray(context.metadata.eclipseBuiltInResourcePacks)
    ? new Set(context.metadata.eclipseBuiltInResourcePacks)
    : new Set();
  const assetEntries = fs.readdirSync(assetDirectory, { withFileTypes: true })
    .filter(entry => (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) || entry.isDirectory());
  const assets = (await mapConcurrent(assetEntries, 6, async entry => {
      try {
        const filePath = path.join(assetDirectory, entry.name);
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || (stat.isFile() && !entry.name.toLowerCase().endsWith('.zip'))
          || (stat.isDirectory() && !isMinecraftAssetDirectory(filePath, selectedType))
          || (!stat.isFile() && !stat.isDirectory())) return null;
        const managed = registry[entry.name] || {};
        const localMetadata = stat.isFile()
          ? await readZipAssetMetadata(filePath, selectedType)
          : await readDirectoryAssetMetadata(filePath, selectedType);
        let modrinthProject = null;
        if (selectedType === 'shader' && managed.projectId && (!managed.description || !managed.icon)) modrinthProject = await getModrinthAssetProject(managed.projectId);
        return {
          fileName: entry.name,
          name: String(managed.name || modrinthProject?.title || entry.name.replace(/\.zip$/i, '').replace(/[-_]+/g, ' ')).slice(0, 180),
          slug: String(managed.slug || ''),
          projectId: String(managed.projectId || ''),
          description: String(localMetadata.description || managed.description || modrinthProject?.description || '').slice(0, 1200),
          icon: localMetadata.icon || secureModrinthIcon(managed.icon || modrinthProject?.icon_url || ''),
          builtIn: builtInResourcePacks.has(entry.name),
          size: stat.isFile() ? stat.size : 0,
          isDirectory: stat.isDirectory()
        };
      } catch { return null; }
    })).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return { folder, assetType: selectedType, installed: true, assets };
}

async function removeInstanceAsset(folder, fileName, assetType) {
  assertModFolderIdle(folder);
  const selectedType = modrinthAssetType(assetType);
  const context = getInstanceModContext(folder);
  const assetDirectory = getInstanceAssetDirectory(context, selectedType);
  if (!assetDirectory) throw new Error('That asset folder is missing.');
  if (typeof fileName !== 'string' || !fileName || path.basename(fileName) !== fileName) throw new Error('That asset file could not be found.');
  if (selectedType === 'resourcepack' && (Array.isArray(context.metadata.eclipseBuiltInResourcePacks) && context.metadata.eclipseBuiltInResourcePacks.includes(fileName))) {
    throw new Error('Eclipse built-in resource packs cannot be removed.');
  }
  const target = path.resolve(assetDirectory, fileName);
  if (path.dirname(target) !== path.resolve(assetDirectory)) throw new Error('That asset file path is invalid.');
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (stat.isFile() && !fileName.toLowerCase().endsWith('.zip'))
    || (stat.isDirectory() && !isMinecraftAssetDirectory(target, selectedType))
    || (!stat.isFile() && !stat.isDirectory())) throw new Error('That asset file is invalid.');
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true });
  else fs.unlinkSync(target);
  const registry = readModrinthAssetRegistry(assetDirectory);
  delete registry[fileName];
  writeModrinthAssetRegistry(assetDirectory, registry);
  return listInstanceAssets(folder, selectedType);
}

async function modrinthJson(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.modrinth.com') throw new Error('The Modrinth API URL was invalid.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(parsed, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': MODRINTH_USER_AGENT } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.description || body.error || `Modrinth returned HTTP ${response.status}.`);
    return body;
  } finally { clearTimeout(timeout); }
}

async function searchModrinthMods(query, folder, options = {}) {
  const context = getInstanceModContext(folder, false);
  const loader = String(context.metadata.loader || 'Fabric').toLowerCase();
  const assetType = options?.assetType === undefined || options.assetType === 'mod' ? 'mod' : modrinthAssetType(options.assetType);
  if (assetType === 'mod' && loader === 'vanilla') throw new Error('Install Fabric or Forge to use mods in this instance.');
  const search = String(query || '').trim();
  const discovery = options?.discovery === true && !search;
  const limit = discovery ? 4 : 24;
  const offset = discovery && Number.isSafeInteger(options.offset) ? Math.max(0, options.offset) : 0;
  const facets = [[`project_type:${assetType === 'mod' ? 'mod' : assetType === 'resourcepack' ? 'resourcepack' : 'shader'}`], [`versions:${context.metadata.version || context.release.version}`]];
  if (assetType === 'mod') facets.push([`categories:${loader}`]);
  const params = new URLSearchParams({
    facets: JSON.stringify(facets),
    index: discovery ? 'downloads' : 'relevance',
    limit: String(limit),
    offset: String(offset)
  });
  if (search) params.set('query', search);
  const body = await modrinthJson(`${MODRINTH_API}/search?${params}`);
  return {
    folder,
    assetType,
    installed: context.installed,
    offset: Number(body.offset) || offset,
    limit: Number(body.limit) || limit,
    totalHits: Number(body.total_hits) || 0,
    projects: (body.hits || []).map(project => ({
      id: String(project.project_id || ''),
      slug: String(project.slug || ''),
      title: String(project.title || project.slug || 'Untitled mod'),
      description: String(project.description || ''),
      icon: secureModrinthIcon(project.icon_url),
      downloads: Number(project.downloads) || 0,
      follows: Number(project.follows) || 0,
      versions: Array.isArray(project.versions) ? project.versions : []
    }))
  };
}

function secureModrinthIcon(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'modrinth.com' || url.hostname.endsWith('.modrinth.com')) ? url.href : '';
  } catch { return ''; }
}

async function findCompatibleModrinthVersion(projectId, context, requestedVersionId = '') {
  const loader = String(context.metadata.loader || 'Fabric').toLowerCase();
  if (loader === 'vanilla') throw new Error('Mods require a Fabric or Forge instance.');
  if (requestedVersionId) {
    const version = await modrinthJson(`${MODRINTH_API}/version/${encodeURIComponent(requestedVersionId)}`);
    if (version.project_id !== projectId || !version.loaders?.includes(loader) || !version.game_versions?.includes(context.metadata.version || context.release.version)) {
      const error = new Error(`A required mod version does not support Minecraft ${context.metadata.version || context.release.version} ${loader}.`);
      error.code = 'MODRINTH_INCOMPATIBLE';
      throw error;
    }
    return version;
  }
  const params = new URLSearchParams({ loaders: JSON.stringify([loader]), game_versions: JSON.stringify([context.metadata.version || context.release.version]), include_changelog: 'false' });
  const versions = await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params}`);
  const gameVersion = context.metadata.version || context.release.version;
  const compatible = Array.isArray(versions) ? versions.filter(version => version.loaders?.includes(loader) && version.game_versions?.includes(gameVersion)) : [];
  if (!compatible.length) {
    const error = new Error(`This mod has no ${loader} version for Minecraft ${gameVersion}.`);
    error.code = 'MODRINTH_INCOMPATIBLE';
    throw error;
  }
  return compatible.find(version => version.version_type === 'release') || compatible[0];
}

async function findCompatibleModrinthVersionWithDependencies(projectId, context, requestedVersionId = '', ancestry = new Set()) {
  const version = await findCompatibleModrinthVersion(projectId, context, requestedVersionId);
  if (ancestry.has(projectId)) return version;
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(projectId);
  const loader = String(context.metadata.loader || 'Fabric').toLowerCase();
  const gameVersion = context.metadata.version || context.release.version;
  const project = await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`);
  const projectName = project.title || project.name || project.slug || projectId;
  for (const dependency of version.dependencies || []) {
    if (dependency.dependency_type !== 'required') continue;
    let dependencyId = dependency.project_id || '';
    if (!dependencyId && dependency.version_id) {
      const dependencyVersion = await modrinthJson(`${MODRINTH_API}/version/${encodeURIComponent(dependency.version_id)}`);
      dependencyId = dependencyVersion.project_id || '';
    }
    if (!dependencyId) {
      const error = new Error(`${projectName} has a required dependency that Eclipse cannot identify.`);
      error.code = 'MODRINTH_INCOMPATIBLE';
      throw error;
    }
    const dependencyProject = await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(dependencyId)}`);
    const dependencyName = dependencyProject.title || dependencyProject.name || dependencyProject.slug || dependencyId;
    try {
      await findCompatibleModrinthVersionWithDependencies(dependencyId, context, dependency.version_id || '', nextAncestry);
    } catch (error) {
      if (error.code === 'MODRINTH_INCOMPATIBLE') {
        const reason = `${projectName} requires ${dependencyName}, which has no compatible ${loader} release for Minecraft ${gameVersion}.`;
        const compatibilityError = new Error(reason);
        compatibilityError.code = 'MODRINTH_INCOMPATIBLE';
        throw compatibilityError;
      }
      throw error;
    }
  }
  return version;
}

async function getOptiFineDownloadsPage() {
  if (cachedOptiFineDownloadsPage && Date.now() - cachedOptiFineDownloadsPageAt < 10 * 60 * 1000) return cachedOptiFineDownloadsPage;
  if (optiFineDownloadsRequest) return optiFineDownloadsRequest;
  optiFineDownloadsRequest = (async () => {
    const response = await fetch('https://optifine.net/downloads', { headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
    if (!response.ok) throw new Error(`OptiFine version lookup failed with HTTP ${response.status}.`);
    const html = await response.text();
    cachedOptiFineDownloadsPage = html;
    cachedOptiFineDownloadsPageAt = Date.now();
    return html;
  })().finally(() => { optiFineDownloadsRequest = null; });
  return optiFineDownloadsRequest;
}

async function getOptiFineReleases(version) {
  const html = await getOptiFineDownloadsPage();
  const escapedVersion = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`<h2>\\s*Minecraft\\s+${escapedVersion}\\s*<\\/h2>([\\s\\S]*?)(?=<h2|$)`, 'i').exec(html);
  if (!heading) return [];
  const rows = [...heading[1].matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)]
    .map(match => ({ className: /\bclass=['"]([^'"]*)['"]/i.exec(match[1])?.[1] || '', html: match[2] }))
    .filter(({ html }) => /class=['"]colFile['"]/.test(html))
    .sort((a, b) => Number(/downloadLinePreview/i.test(a.className)) - Number(/downloadLinePreview/i.test(b.className)));
  const releases = [];
  for (const { className, html: row } of rows) {
    const fileMatch = /class=['"]colDownload['"][\s\S]*?href=['"][^'"]*adloadx\?f=([^&'"]+)[^'"]*['"]/i.exec(row) ||
      /class=['"]colMirror['"][\s\S]*?href=['"][^'"]*adloadx\?f=([^&'"]+)[^'"]*['"]/i.exec(row);
    const forgeMatch = /class=['"]colForge['"]>([\s\S]*?)<\/td>/i.exec(row);
    if (!fileMatch || !forgeMatch || !/class=['"]colFile['"]/.test(row)) continue;
    const filename = decodeURIComponent(fileMatch[1]);
    if (!/^(?:preview_)?OptiFine_[A-Za-z0-9._-]+\.jar$/i.test(filename)) continue;
    const forgeRequirement = forgeMatch[1].replace(/<[^>]*>/g, '').trim();
    if (!forgeRequirement) continue;
    releases.push({ filename, forgeRequirement, preview: /downloadLinePreview/i.test(className) });
  }
  return releases;
}

async function findOptiFineRelease(version) {
  const releases = await getOptiFineReleases(version);
  return releases.find(release => !/^Forge\s+N\/A$/i.test(release.forgeRequirement)) || releases[0] || null;
}

async function getTLSkinModPage() {
  if (cachedTLSkinModPage && Date.now() - cachedTLSkinModPageAt < 10 * 60 * 1000) return cachedTLSkinModPage;
  if (tlSkinModPageRequest) return tlSkinModPageRequest;
  tlSkinModPageRequest = (async () => {
    const response = await fetch(TL_SKIN_MOD_PAGE, { headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
    if (!response.ok) throw new Error(`TL Skin & Cape version lookup failed with HTTP ${response.status}.`);
    const pageUrl = new URL(response.url);
    if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== 'www.9minecraft.net') throw new Error(`TL Skin & Cape redirected to an unexpected website (${pageUrl.hostname}).`);
    cachedTLSkinModPage = await response.text();
    cachedTLSkinModPageAt = Date.now();
    return cachedTLSkinModPage;
  })().finally(() => { tlSkinModPageRequest = null; });
  return tlSkinModPageRequest;
}

function decodeHtmlAttribute(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&#0*38;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

async function findTLSkinModRelease(version, loader) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Choose a valid Minecraft version first.');
  const selectedLoader = String(loader || '').toLowerCase();
  if (!['fabric', 'forge'].includes(selectedLoader)) return null;
  const html = await getTLSkinModPage();
  const rowStarts = [...html.matchAll(/<div\b(?=[^>]*\bclass=['"][^'"]*\bmcdm-row(?=\s|['"])[^'"]*['"])([^>]*)>/gi)];
  for (let index = 0; index < rowStarts.length; index++) {
    const attributes = rowStarts[index][1];
    const rowVersions = /\bdata-ver=['"]([^'"]+)['"]/i.exec(attributes)?.[1].split(',').map(item => item.trim()).filter(Boolean) || [];
    const rowLoader = /\bdata-ld=['"]([^'"]+)['"]/i.exec(attributes)?.[1]?.toLowerCase();
    if (!rowVersions.includes(version) || rowLoader !== selectedLoader) continue;
    const rowEnd = rowStarts[index + 1]?.index ?? html.length;
    const rowHtml = html.slice(rowStarts[index].index, rowEnd);
    const links = [...rowHtml.matchAll(/<a\b([^>]*)>/gi)]
      .map(match => match[1])
      .filter(attrs => /\bclass=['"][^'"]*\bmcdm-dl-link(?=\s|['"])[^'"]*['"]/i.test(attrs))
      .map(attrs => /\bhref=['"]([^'"]+)['"]/i.exec(attrs)?.[1])
      .filter(Boolean);
    const downloadPageUrls = links.map(href => {
      try { return new URL(decodeHtmlAttribute(href), TL_SKIN_MOD_PAGE); } catch { return null; }
    }).filter(url => url && url.protocol === 'https:' && TL_SKIN_ALLOWED_HOST(url.hostname));
    if (!downloadPageUrls.length) continue;
    const expectedLoader = selectedLoader === 'fabric' ? 'Fabric' : 'Forge';
    const validFilename = filename => new RegExp(`^TL-Skin-and-Cape-Mod-${expectedLoader}-[A-Za-z0-9._-]+\\.jar$`, 'i').test(filename)
      && rowVersions.some(rowVersion => filename.endsWith(`-${rowVersion}.jar`));
    const filename = downloadPageUrls.map(url => url.searchParams.get('file') || '').find(validFilename)
      || `TL-Skin-and-Cape-Mod-${expectedLoader}-${rowVersions[0]}.jar`;
    const matchingUrls = downloadPageUrls.filter(url => {
      const file = url.searchParams.get('file');
      return file ? validFilename(file) : url.searchParams.get('act') === 'dl' && /^\d+$/.test(url.searchParams.get('id') || '');
    });
    if (!matchingUrls.length) continue;
    return { version, versions: rowVersions, loader: selectedLoader, filename, downloadPageUrls: matchingUrls.map(url => url.href) };
  }
  return null;
}

async function getTLSkinModOptions(version, loader) {
  const selectedLoader = String(loader || '').toLowerCase();
  if (!['fabric', 'forge'].includes(selectedLoader)) return { available: false, reason: 'TL Skin & Cape requires Fabric or Forge.' };
  const release = await findTLSkinModRelease(version, selectedLoader);
  return release
    ? { available: true, filename: release.filename, reason: '' }
    : { available: false, reason: `TL Skin & Cape has no ${selectedLoader === 'fabric' ? 'Fabric' : 'Forge'} file for Minecraft ${version}.` };
}

async function downloadTLSkinMod(event, folder, instancePath, version, loader) {
  const release = await findTLSkinModRelease(version, loader);
  if (!release) throw new Error(`TL Skin & Cape has no ${loader} file for Minecraft ${version}.`);
  const modsPath = path.join(instancePath, 'mods');
  fs.mkdirSync(modsPath, { recursive: true });
  let destination = path.join(modsPath, release.filename);
  if (fs.existsSync(destination)) {
    const existing = fs.lstatSync(destination);
    const header = existing.isFile() && !existing.isSymbolicLink() && existing.size >= 4
      ? Buffer.alloc(4)
      : null;
    if (header) {
      const fd = fs.openSync(destination, 'r');
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (header.toString('hex') === '504b0304') return;
    }
    throw new Error(`A file named ${release.filename} already exists in this instance’s mods folder.`);
  }

  let bytes = null;
  let lastError = null;
  for (const downloadPageUrl of release.downloadPageUrls) {
    try {
      sendInstallProgress(event, folder, { phase: 'skin-mod', status: 'Opening the TL Skin & Cape download page', percent: null });
      const landingResponse = await fetch(downloadPageUrl, { redirect: 'follow', headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
      if (!landingResponse.ok) throw new Error(`The download page returned HTTP ${landingResponse.status}.`);
      const landingUrl = new URL(landingResponse.url);
      if (landingUrl.protocol !== 'https:' || !TL_SKIN_ALLOWED_HOST(landingUrl.hostname)) throw new Error(`The site redirected to an unexpected download page (${landingUrl.hostname}).`);
      let downloadUrl;
      if (landingUrl.pathname === '/dl2.php' && landingUrl.searchParams.get('file') === release.filename) {
        const cookies = typeof landingResponse.headers.getSetCookie === 'function'
          ? landingResponse.headers.getSetCookie()
          : [landingResponse.headers.get('set-cookie')].filter(Boolean);
        const cookieHeader = cookies.map(cookie => cookie.split(';', 1)[0]).filter(Boolean).join('; ');
        if (!cookieHeader) throw new Error('The download page did not provide its required session.');
        downloadUrl = new URL(landingUrl.href);
        downloadUrl.searchParams.set('dl', '1');
        downloadUrl._cookieHeader = cookieHeader;
      } else if (landingUrl.pathname === '/index.php' && landingUrl.searchParams.get('act') === 'dl' && landingUrl.searchParams.get('id') === new URL(downloadPageUrl).searchParams.get('id')) {
        const pageHtml = await landingResponse.text();
        const title = /<title>\s*(TL-Skin-and-Cape-Mod-(?:Fabric|Forge)-[A-Za-z0-9._-]+\.jar)/i.exec(pageHtml)?.[1] || '';
        if (!new RegExp(`^TL-Skin-and-Cape-Mod-${loader === 'fabric' ? 'Fabric' : 'Forge'}-[A-Za-z0-9._-]+\\.jar$`, 'i').test(title)
          || !release.versions.some(rowVersion => title.endsWith(`-${rowVersion}.jar`))) throw new Error('The download page did not identify the expected TL Skin & Cape file.');
        release.filename = title;
        destination = path.join(modsPath, release.filename);
        if (fs.existsSync(destination)) throw new Error(`A file named ${release.filename} already exists in this instance’s mods folder.`);
        const buttonHref = /<a\b(?=[^>]*\bid=['"]download-button['"])[^>]*\bhref=['"]([^'"]+)['"]/i.exec(pageHtml)?.[1];
        if (!buttonHref) throw new Error('The download page did not show its final download button.');
        downloadUrl = new URL(decodeHtmlAttribute(buttonHref), landingUrl);
        if (downloadUrl.protocol !== 'https:' || !TL_SKIN_ALLOWED_HOST(downloadUrl.hostname) || downloadUrl.pathname !== '/index.php'
          || downloadUrl.searchParams.get('act') !== 'download' || downloadUrl.searchParams.get('id') !== landingUrl.searchParams.get('id') || !downloadUrl.searchParams.get('hash')) {
          throw new Error('The final download button points to an unexpected file.');
        }
      } else throw new Error('The site redirected to an unexpected download page.');
      sendInstallProgress(event, folder, { phase: 'skin-mod', status: 'Downloading TL Skin & Cape', percent: null });
      const response = await fetch(downloadUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': LAUNCHER_USER_AGENT, ...(downloadUrl._cookieHeader ? { Cookie: downloadUrl._cookieHeader } : {}), Accept: 'application/java-archive, application/octet-stream' }
      });
      if (!response.ok || !response.body) throw new Error(`The file request returned HTTP ${response.status}.`);
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || !TL_SKIN_ALLOWED_HOST(finalUrl.hostname)) throw new Error(`The file redirected to an unexpected host (${finalUrl.hostname}).`);
      if (finalUrl.hostname === '9sims4.com' || finalUrl.hostname.endsWith('.9sims4.com')) {
        let finalFilename = '';
        try { finalFilename = decodeURIComponent(finalUrl.pathname.split('/').pop() || ''); } catch {}
        if (!/^\/9mc\//i.test(finalUrl.pathname) || finalFilename !== release.filename) {
          throw new Error('The download host did not return the expected TL Skin & Cape file.');
        }
      }
      const maxBytes = 25 * 1024 * 1024;
      const contentLength = Number(response.headers.get('content-length')) || 0;
      if (contentLength > maxBytes) throw new Error('The file is larger than Eclipse allows.');
      const chunks = [];
      let received = 0;
      for await (const chunk of Readable.fromWeb(response.body)) {
        received += chunk.length;
        if (received > maxBytes) throw new Error('The file is larger than Eclipse allows.');
        chunks.push(chunk);
      }
      const candidate = Buffer.concat(chunks);
      if (candidate.length < 4 || candidate.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('The server did not return a valid JAR.');
      bytes = candidate;
      break;
    } catch (error) { lastError = error; }
  }
  if (!bytes) throw new Error(`Could not download TL Skin & Cape from either server. ${lastError?.message || ''}`.trim());
  fs.writeFileSync(destination, bytes, { flag: 'wx' });
  sendInstallProgress(event, folder, { phase: 'skin-mod', status: 'TL Skin & Cape installed', percent: 99 });
}

function optiFineSupportsForgeBuild(release, forgeVersion) {
  if (!release || !forgeVersion) return false;
  const forgeBuild = forgeVersion.split('-').slice(1).join('-');
  const requiredBuild = release.forgeRequirement.replace(/^Forge\s*/i, '').trim();
  if (requiredBuild.startsWith('#')) {
    const legacyBuild = requiredBuild.slice(1);
    const escapedBuild = legacyBuild.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return forgeBuild === legacyBuild || new RegExp(`(?:^|[.-])${escapedBuild}(?:$|[.-])`).test(forgeBuild);
  }
  return Boolean(forgeBuild && requiredBuild === forgeBuild);
}

function optiFineCanBeAddedToForge(release, forgeVersion) {
  if (optiFineSupportsForgeBuild(release, forgeVersion)) return true;
  return Boolean(release?.preview && forgeVersion && /^Forge\s+N\/A$/i.test(release.forgeRequirement));
}

async function getPerformanceModOptions(version, loader) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Choose a valid Minecraft version first.');
  const selectedLoader = String(loader || '').toLowerCase();
  if (selectedLoader === 'fabric') {
    const context = { metadata: { version, loader: 'Fabric' } };
    return Promise.all(PERFORMANCE_MODS.map(async mod => {
      try {
        await findCompatibleModrinthVersionWithDependencies(mod.id, context);
        return { ...mod, available: true, reason: '' };
      } catch (error) {
        if (error.code === 'MODRINTH_INCOMPATIBLE') {
          return { ...mod, available: false, reason: error.message };
        }
        throw error;
      }
    }));
  }
  if (selectedLoader === 'forge') {
    const optiFineReleases = await getOptiFineReleases(version);
    const optiFine = optiFineReleases.find(release => !/^Forge\s+N\/A$/i.test(release.forgeRequirement)) || optiFineReleases[0] || null;
    const requiredForgeBuild = optiFine?.forgeRequirement.replace(/^Forge\s*/i, '').trim() || '';
    const forgeVersion = /^N\/A$/i.test(requiredForgeBuild)
      ? await getForgeBuildForMinecraft(version)
      : await getForgeBuildForMinecraft(version, requiredForgeBuild);
    const available = optiFineCanBeAddedToForge(optiFine, forgeVersion);
    return [{
      id: 'optifine',
      slug: 'optifine',
      name: 'OptiFine',
      available,
      reason: !optiFine ? `OptiFine has no release for Minecraft ${version}.` :
        /^Forge\s+N\/A$/i.test(optiFine.forgeRequirement) ? !forgeVersion
          ? `OptiFine preview release found, but Forge has no installer for Minecraft ${version}.`
          : `Preview release found. OptiFine lists Forge as N/A, so compatibility with Forge ${forgeVersion.split('-').slice(1).join('-')} is unverified.` :
        !forgeVersion ? `The Forge build required by OptiFine (${requiredForgeBuild}) is unavailable for Minecraft ${version}.` : ''
    }];
  }
  return [];
}

async function getUtilityModOptions(version, loader) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Choose a valid Minecraft version first.');
  const selectedLoader = String(loader || '').toLowerCase();
  if (selectedLoader !== 'fabric') return [];
  const context = { metadata: { version, loader: selectedLoader } };
  return Promise.all(UTILITY_MODS.map(async mod => {
    try {
      await findCompatibleModrinthVersionWithDependencies(mod.id, context);
      return { ...mod, available: true, reason: '' };
    } catch (error) {
      if (error.code === 'MODRINTH_INCOMPATIBLE') {
        return { ...mod, available: false, reason: error.message };
      }
      throw error;
    }
  }));
}

async function getEclipseCustomizationOptions(version, loader) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Choose a valid Minecraft version first.');
  const selectedLoader = String(loader || '').toLowerCase();
  if (!['fabric', 'forge'].includes(selectedLoader)) return [];
  const key = `${selectedLoader}:${version}`;
  if (!eclipseCustomizationOptionsCache.has(key)) {
    const context = { metadata: { version, loader: selectedLoader } };
    const request = Promise.all(ECLIPSE_CUSTOMIZATION_MODS.map(async mod => {
      try {
        await findCompatibleModrinthVersionWithDependencies(mod.id, context);
        return { ...mod, available: true, reason: '' };
      } catch (error) {
        if (error.code === 'MODRINTH_INCOMPATIBLE') {
          return { ...mod, available: false, reason: error.message };
        }
        throw error;
      }
    })).catch(error => {
      eclipseCustomizationOptionsCache.delete(key);
      throw error;
    });
    eclipseCustomizationOptionsCache.set(key, request);
  }
  return eclipseCustomizationOptionsCache.get(key);
}

async function downloadOptiFine(event, folder, instancePath, version, forgeBuild) {
  const modsPath = path.join(instancePath, 'mods');
  if (listJarFiles(modsPath).some(fileName => /optifine/i.test(fileName))) {
    sendInstallProgress(event, folder, { phase: 'performance-mods', status: 'OptiFine is already present; skipping it', percent: 99 });
    return { skipped: true };
  }
  const release = await findOptiFineRelease(version);
  const forgeVersion = `${version}-${forgeBuild || ''}`;
  if (!optiFineCanBeAddedToForge(release, forgeVersion)) throw new Error(`OptiFine cannot be added to the Forge build selected for Minecraft ${version}.`);
  const startUrl = new URL(`/adloadx?f=${encodeURIComponent(release.filename)}`, 'https://optifine.net');
  sendInstallProgress(event, folder, { phase: 'performance-mods', status: 'Preparing the official OptiFine download', percent: 92 });
  const landingResponse = await fetch(startUrl, { headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
  if (!landingResponse.ok) throw new Error(`OptiFine download page returned HTTP ${landingResponse.status}.`);
  const landingUrl = new URL(landingResponse.url);
  if (landingUrl.protocol !== 'https:' || landingUrl.hostname !== 'optifine.net') throw new Error('OptiFine redirected to an unexpected website.');
  const landingHtml = await landingResponse.text();
  const downloadPath = /href=['"](downloadx\?f=[^'"]+)['"]/i.exec(landingHtml)?.[1];
  if (!downloadPath) throw new Error('OptiFine did not provide a direct download link.');
  const downloadUrl = new URL(downloadPath, 'https://optifine.net/');
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'optifine.net' || downloadUrl.pathname !== '/downloadx') {
    throw new Error('OptiFine provided an unsafe download link.');
  }
  sendInstallProgress(event, folder, { phase: 'performance-mods', status: 'Downloading OptiFine from optifine.net', percent: null });
  const response = await fetch(downloadUrl, { redirect: 'follow', headers: { 'User-Agent': LAUNCHER_USER_AGENT, Accept: 'application/java-archive, application/octet-stream' } });
  if (!response.ok || !response.body) throw new Error(`OptiFine download failed with HTTP ${response.status}.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'optifine.net') throw new Error('OptiFine redirected to an unexpected website.');
  const maxBytes = 100 * 1024 * 1024;
  const contentLength = Number(response.headers.get('content-length')) || 0;
  if (contentLength > maxBytes) throw new Error('The OptiFine file is larger than Eclipse allows.');
  const chunks = [];
  let received = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    received += chunk.length;
    if (received > maxBytes) throw new Error('The OptiFine file is larger than Eclipse allows.');
    chunks.push(chunk);
    const percent = contentLength ? Math.round(92 + received / contentLength * 7) : null;
    sendInstallProgress(event, folder, { phase: 'performance-mods', status: 'Downloading OptiFine from optifine.net', percent });
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 4 || bytes.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('The OptiFine download was not a valid JAR.');
  fs.mkdirSync(modsPath, { recursive: true });
  const destination = path.join(modsPath, release.filename);
  if (fs.existsSync(destination)) return { skipped: true };
  fs.writeFileSync(destination, bytes, { flag: 'wx' });
  return release;
}

function chooseModrinthJar(version) {
  const files = Array.isArray(version.files) ? version.files : [];
  const jarFiles = files.filter(file => typeof file.filename === 'string' && file.filename.toLowerCase().endsWith('.jar'));
  const file = jarFiles.find(candidate => candidate.primary) || jarFiles[0];
  if (!file || !file.url || !file.hashes || (!file.hashes.sha512 && !file.hashes.sha1)) throw new Error('Modrinth did not provide a verifiable JAR file for this version.');
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || !(url.hostname === 'modrinth.com' || url.hostname.endsWith('.modrinth.com'))) throw new Error('Modrinth returned an unsafe download URL.');
  return file;
}

async function downloadModrinthJar(file, destination, report) {
  const maxBytes = Math.min(MODRINTH_MAX_JAR_SIZE, Number.isFinite(file.size) && file.size > 0 ? file.size : MODRINTH_MAX_JAR_SIZE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(file.url, { signal: controller.signal, redirect: 'follow', headers: { Accept: 'application/java-archive, application/octet-stream', 'User-Agent': MODRINTH_USER_AGENT } });
    if (!response.ok || !response.body) throw new Error(`Modrinth download failed with HTTP ${response.status}.`);
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || !(finalUrl.hostname === 'modrinth.com' || finalUrl.hostname.endsWith('.modrinth.com'))) throw new Error('Modrinth redirected to an unsafe download URL.');
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength > maxBytes) throw new Error('This mod file is larger than Eclipse allows.');
    let received = 0;
    const algorithm = file.hashes.sha512 ? 'sha512' : 'sha1';
    const hash = crypto.createHash(algorithm);
    const meter = new (require('stream').Transform)({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) return callback(new Error('This mod file is larger than Eclipse allows.'));
        hash.update(chunk);
        report?.(received, Number(file.size) || contentLength || 0);
        callback(null, chunk);
      }
    });
    await require('stream/promises').pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination, { flags: 'wx' }), { signal: controller.signal });
    if (Number(file.size) > 0 && received !== Number(file.size)) throw new Error('The downloaded mod file has an unexpected size.');
    if (hash.digest('hex').toLowerCase() !== String(file.hashes[algorithm]).toLowerCase()) throw new Error('The downloaded mod failed its Modrinth checksum verification.');
    return received;
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally { clearTimeout(timeout); }
}

function chooseModrinthAssetZip(version) {
  const files = Array.isArray(version.files) ? version.files : [];
  const zipFiles = files.filter(file => typeof file.filename === 'string' && file.filename.toLowerCase().endsWith('.zip'));
  const file = zipFiles.find(candidate => candidate.primary) || zipFiles[0];
  if (!file || !file.url || !file.hashes || (!file.hashes.sha512 && !file.hashes.sha1)) throw new Error('Modrinth did not provide a verifiable ZIP file for this asset.');
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || !(url.hostname === 'modrinth.com' || url.hostname.endsWith('.modrinth.com'))) throw new Error('Modrinth returned an unsafe asset download URL.');
  if (Number(file.size) > MODRINTH_MAX_ASSET_SIZE) throw new Error('This resource pack or shader pack is larger than Eclipse allows.');
  return file;
}

async function findCompatibleModrinthAssetVersion(projectId, minecraftVersion) {
  const params = new URLSearchParams({ game_versions: JSON.stringify([minecraftVersion]), include_changelog: 'false' });
  const versions = await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params}`);
  const compatible = Array.isArray(versions)
    ? versions.filter(version => version.game_versions?.includes(minecraftVersion))
    : [];
  if (!compatible.length) throw new Error(`This asset has no release for Minecraft ${minecraftVersion}.`);
  return compatible.find(version => version.version_type === 'release') || compatible[0];
}

async function downloadModrinthAssetZip(file, destination) {
  const maxBytes = Math.min(MODRINTH_MAX_ASSET_SIZE, Number.isFinite(file.size) && file.size > 0 ? file.size : MODRINTH_MAX_ASSET_SIZE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(file.url, { signal: controller.signal, redirect: 'follow', headers: { Accept: 'application/zip, application/octet-stream', 'User-Agent': MODRINTH_USER_AGENT } });
    if (!response.ok || !response.body) throw new Error(`Modrinth asset download failed with HTTP ${response.status}.`);
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || !(finalUrl.hostname === 'modrinth.com' || finalUrl.hostname.endsWith('.modrinth.com'))) throw new Error('Modrinth redirected to an unsafe asset download URL.');
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength > maxBytes) throw new Error('This resource pack or shader pack is larger than Eclipse allows.');
    let received = 0;
    const algorithm = file.hashes.sha512 ? 'sha512' : 'sha1';
    const hash = crypto.createHash(algorithm);
    const meter = new (require('stream').Transform)({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) return callback(new Error('This resource pack or shader pack is larger than Eclipse allows.'));
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await require('stream/promises').pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination, { flags: 'wx' }), { signal: controller.signal });
    if (Number(file.size) > 0 && received !== Number(file.size)) throw new Error('The downloaded asset has an unexpected size.');
    if (hash.digest('hex').toLowerCase() !== String(file.hashes[algorithm]).toLowerCase()) throw new Error('The downloaded asset failed its Modrinth checksum verification.');
    const fd = fs.openSync(destination, 'r');
    const signature = Buffer.alloc(4);
    try { fs.readSync(fd, signature, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (signature.toString('hex') !== '504b0304') throw new Error('The downloaded resource pack or shader pack is not a valid ZIP archive.');
    return received;
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally { clearTimeout(timeout); }
}

async function installModrinthAsset(event, folder, projectId, assetType) {
  const selectedType = modrinthAssetType(assetType);
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error('That Modrinth asset could not be found.');
  assertModFolderIdle(folder);
  const context = getInstanceModContext(folder);
  const assetDirectory = getInstanceAssetDirectory(context, selectedType, true);
  activeModInstalls.add(folder);
  const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-modrinth-asset-'));
  const stagedFile = path.join(staging, 'asset.zip');
  let createdDestination = '';
  try {
    const project = await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`);
    const expectedType = selectedType === 'resourcepack' ? 'resourcepack' : 'shader';
    if (project.project_type !== expectedType) throw new Error('That Modrinth project is not the selected asset type.');
    const registry = readModrinthAssetRegistry(assetDirectory);
    if (Object.values(registry).some(asset => asset?.projectId === projectId)) {
      return { folder, assetType: selectedType, installedCount: 0 };
    }
    const minecraftVersion = String(context.metadata.version || context.release.version || '');
    const version = await findCompatibleModrinthAssetVersion(projectId, minecraftVersion);
    const file = chooseModrinthAssetZip(version);
    let filename = path.basename(file.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
    if (!filename.toLowerCase().endsWith('.zip') || filename.length < 5) throw new Error('Modrinth returned an invalid ZIP filename.');
    if (fs.existsSync(path.join(assetDirectory, filename))) {
      const stem = filename.slice(0, -4);
      filename = `${stem}-${String(version.id || '').slice(0, 6)}.zip`;
      if (fs.existsSync(path.join(assetDirectory, filename))) throw new Error(`An asset named ${filename} already exists.`);
    }
    await downloadModrinthAssetZip(file, stagedFile);
    const destination = path.resolve(assetDirectory, filename);
    if (path.dirname(destination) !== path.resolve(assetDirectory)) throw new Error('The asset filename is unsafe.');
    fs.copyFileSync(stagedFile, destination, fs.constants.COPYFILE_EXCL);
    createdDestination = destination;
    registry[filename] = {
      projectId,
      slug: String(project.slug || ''),
      name: String(project.title || project.slug || filename.replace(/\.zip$/i, '')),
      description: String(project.description || '').slice(0, 1200),
      icon: secureModrinthIcon(project.icon_url || ''),
      version: String(version.version_number || ''),
      versionId: String(version.id || '')
    };
    writeModrinthAssetRegistry(assetDirectory, registry);
    return { folder, assetType: selectedType, installedCount: 1, fileName: filename };
  } catch (error) {
    if (createdDestination) fs.rmSync(createdDestination, { force: true });
    throw error;
  } finally {
    activeModInstalls.delete(folder);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function installModrinthProject(event, folder, projectId, duringInstanceInstall = false) {
  const projectIds = [...new Set(Array.isArray(projectId) ? projectId : [projectId])];
  if (!projectIds.length || projectIds.length > PERFORMANCE_MODS.length + UTILITY_MODS.length + 2 || projectIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    throw new Error('That Modrinth project could not be found.');
  }
  if (duringInstanceInstall) {
    if (!activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
      throw new Error('The instance is not ready to install its selected performance mods.');
    }
  } else assertModFolderIdle(folder);
  const context = getInstanceModContext(folder, !duringInstanceInstall, true);
  // Keep staged JARs on the destination volume so installing a validated file
  // is an atomic rename instead of a second full-size disk copy.
  fs.mkdirSync(context.modsPath, { recursive: true });
  const staging = fs.mkdtempSync(path.join(context.modsPath, '.eclipse-modrinth-'));
  activeModInstalls.add(folder);
  const createdModFiles = [];
  const sendProgress = update => {
    if (!duringInstanceInstall) return;
    // Automatic installs belong to the instance-install flow. Sending the
    // same completion event to the Mods page leaves its manual-install panel
    // visible after background setup has finished.
    sendInstallProgress(event, folder, {
      phase: 'performance-mods',
      status: update.status || 'Installing performance mods',
      percent: update.percent == null ? null : Math.round(92 + update.percent * 0.07)
    });
  };
  try {
    const registry = readModrinthRegistry(context.modsPath);
    // Modrinth's registry and JAR filenames are enough to detect installed
    // projects; opening every JAR to parse metadata makes each install slower.
    const existingProjects = new Set(Object.values(registry).map(mod => mod?.projectId).filter(Boolean));
    const existingModFiles = listJarFiles(context.modsPath);
    const existingModIds = new Set(existingModFiles.map(fileName => normalizeModIdentity(baseJarName(fileName))).filter(Boolean));
    const projectCache = new Map();
    const versionCache = new Map();
    const dependencyVersionCache = new Map();
    const getProject = id => {
      if (!projectCache.has(id)) projectCache.set(id, modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}`));
      return projectCache.get(id);
    };
    const isInstalled = async id => {
      if (existingProjects.has(id)) return true;
      const project = await getProject(id);
      const projectSlug = normalizeModIdentity(project.slug);
      const projectTitle = normalizeModIdentity(project.title);
      return existingModIds.has(projectSlug) || existingModIds.has(projectTitle)
        || existingModFiles.some(fileName => modFilenameMatchesProject(fileName, project));
    };
    const getVersion = (id, versionId = '') => {
      const key = `${id}:${versionId}`;
      if (!versionCache.has(key)) versionCache.set(key, findCompatibleModrinthVersion(id, context, versionId));
      return versionCache.get(key);
    };
    const visitPromises = new Map();
    const requestedVersions = new Map();
    const resolved = [];
    const visit = (id, label, versionId = '', ancestry = new Set()) => {
      if (ancestry.has(id)) return Promise.resolve();
      if (visitPromises.has(id)) {
        const requested = requestedVersions.get(id);
        if (versionId !== requested && (versionId || requested)) {
          const error = new Error(`The required dependency graph requests conflicting versions of ${label}.`);
          error.code = 'MODRINTH_INCOMPATIBLE';
          return Promise.reject(error);
        }
        return visitPromises.get(id);
      }
      requestedVersions.set(id, versionId);
      const nextAncestry = new Set(ancestry);
      nextAncestry.add(id);
      const work = (async () => {
      const installedRecord = Object.values(registry).find(mod => mod?.projectId === id);
      const installed = await isInstalled(id);
      if (installed && versionId && installedRecord?.versionId && installedRecord.versionId !== versionId) {
        const error = new Error(`${label} requires a different version than the one already installed.`);
        error.code = 'MODRINTH_INCOMPATIBLE';
        throw error;
      }
      const version = await getVersion(id, versionId || (installed ? installedRecord?.versionId || '' : ''));
      const requiredDependencies = await Promise.all((version.dependencies || [])
        .filter(dependency => dependency.dependency_type === 'required')
        .map(async dependency => {
          let versionInfo = null;
          if (dependency.version_id) {
            if (!dependencyVersionCache.has(dependency.version_id)) {
              dependencyVersionCache.set(dependency.version_id, modrinthJson(`${MODRINTH_API}/version/${encodeURIComponent(dependency.version_id)}`));
            }
            versionInfo = await dependencyVersionCache.get(dependency.version_id);
          }
          const dependencyId = dependency.project_id || versionInfo?.project_id || '';
          if (!dependencyId) throw new Error(`${label} has a required external dependency that Eclipse cannot resolve automatically.`);
          const project = await getProject(dependencyId);
          return {
            id: dependencyId,
            name: project.title || project.name || project.slug || 'Required dependency',
            versionId: dependency.version_id || ''
          };
        }));
      await Promise.all(requiredDependencies.map(async dependency => {
        const dependencyId = dependency.id;
        const dependencyName = dependency.name;
        if (!dependencyId) throw new Error(`${label} has a required external dependency that Eclipse cannot resolve automatically.`);
        try {
          await visit(dependencyId, dependencyName, dependency.versionId, nextAncestry);
        } catch (error) {
          if (error.code === 'MODRINTH_INCOMPATIBLE') {
            const compatibilityError = new Error(`${label} requires ${dependencyName}, which does not support this ${context.metadata.loader} instance and Minecraft ${context.metadata.version || context.release.version}.`);
            compatibilityError.code = 'MODRINTH_INCOMPATIBLE';
            throw compatibilityError;
          }
          throw error;
        }
      }));
      const project = await getProject(id);
      if (!installed) {
        const file = chooseModrinthJar(version);
        resolved.push({ projectId: id, slug: String(project.slug || ''), name: String(project.title || label), description: String(project.description || ''), icon: secureModrinthIcon(project.icon_url), versionId: version.id, version: version.version_number, file });
      }
      })();
      visitPromises.set(id, work);
      return work;
    };
    sendProgress({ status: 'Checking compatible versions and dependencies', percent: 4 });
    await Promise.all(projectIds.map(async id => {
      const project = await getProject(id);
      await visit(id, project.title || project.name || project.slug || 'Mod');
    }));
    if (!resolved.length) {
      sendProgress({ status: 'The mod and its required dependencies are already installed', percent: 100, complete: true });
      return { folder, installed: true, installedCount: 0, mods: [] };
    }

    const staged = new Array(resolved.length);
    const expectedBytes = resolved.reduce((total, item) => total + (Number(item.file.size) || 0), 0);
    const receivedByFile = new Array(resolved.length).fill(0);
    let receivedBytes = 0;
    let completedDownloads = 0;
    let nextDownload = 0;
    let firstDownloadError = null;
    const downloadWorker = async () => {
      while (!firstDownloadError) {
        const index = nextDownload++;
        if (index >= resolved.length) return;
        const item = resolved[index];
        const filename = path.basename(item.file.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
        if (!filename.toLowerCase().endsWith('.jar')) {
          firstDownloadError = new Error('Modrinth returned a file that is not a JAR.');
          return;
        }
        const stagedPath = path.join(staging, `${index}.jar`);
        if (duringInstanceInstall) sendProgress({ status: `Downloading ${item.name}`, percent: Math.round(8 + 84 * (expectedBytes ? receivedBytes / expectedBytes : completedDownloads / resolved.length)) });
        try {
          const onDownloadProgress = duringInstanceInstall ? received => {
            const current = Math.max(receivedByFile[index], Number(received) || 0);
            receivedBytes += current - receivedByFile[index];
            receivedByFile[index] = current;
            const fraction = expectedBytes ? receivedBytes / expectedBytes : completedDownloads / resolved.length;
            sendProgress({ status: `Downloading ${item.name}`, percent: Math.min(92, Math.round(8 + 84 * fraction)) });
          } : undefined;
          await downloadModrinthJar(item.file, stagedPath, onDownloadProgress);
          completedDownloads++;
          staged[index] = { ...item, filename, stagedPath };
        } catch (error) {
          firstDownloadError ||= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, resolved.length) }, downloadWorker));
    if (firstDownloadError) throw firstDownloadError;

    const newNames = new Set();
    for (const item of staged) {
      let filename = item.filename;
      if (fs.existsSync(path.join(context.modsPath, filename)) || newNames.has(filename.toLowerCase())) {
        const stem = filename.slice(0, -4);
        filename = `${stem}-${item.versionId.slice(0, 6)}.jar`;
      }
      if (fs.existsSync(path.join(context.modsPath, filename)) || newNames.has(filename.toLowerCase())) throw new Error(`A mod file named ${filename} already exists.`);
      item.filename = filename;
      newNames.add(filename.toLowerCase());
    }

    for (const item of staged) {
      const destination = path.resolve(context.modsPath, item.filename);
      if (path.dirname(destination) !== path.resolve(context.modsPath)) throw new Error('A mod download contained an unsafe filename.');
      fs.renameSync(item.stagedPath, destination);
      createdModFiles.push(destination);
      registry[item.filename] = { projectId: item.projectId, slug: item.slug, name: item.name, description: item.description, icon: item.icon, modId: '', version: item.version, versionId: item.versionId };
    }
    writeModrinthRegistry(context.modsPath, registry);
    sendProgress({ status: `Installed ${resolved.length} mod${resolved.length === 1 ? '' : 's'} with required dependencies`, percent: 100, complete: true });
    return {
      folder,
      installed: true,
      installedCount: staged.length,
      mods: staged.map(item => ({
        fileName: item.filename,
        baseName: item.filename,
        id: item.slug,
        name: item.name,
        version: item.version,
        description: item.description || 'No description is available for this mod.',
        icon: item.icon,
        builtIn: false,
        protectedBuiltIn: false,
        enabled: true,
        modrinthProjectId: item.projectId,
        modrinthSlug: item.slug,
        modifiedAt: Date.now()
      }))
    };
  } catch (error) {
    for (const filePath of createdModFiles) fs.rmSync(filePath, { force: true });
    sendProgress({ status: error.message || 'Mod installation failed', percent: null, error: true });
    throw error;
  } finally {
    activeModInstalls.delete(folder);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function installPerformanceMods(event, folder, instancePath, metadata) {
  const loader = String(metadata.loader || '').toLowerCase();
  const performanceIds = new Set(PERFORMANCE_MODS.map(mod => mod.id));
  const utilityIds = new Set(UTILITY_MODS.map(mod => mod.id));
  const projectIds = loader === 'fabric' && Array.isArray(metadata.performanceMods)
    ? metadata.performanceMods.filter(id => performanceIds.has(id))
    : [];
  if (loader === 'fabric' && Array.isArray(metadata.utilityMods)) {
    projectIds.push(...metadata.utilityMods.filter(id => utilityIds.has(id)));
  }
  if (loader === 'fabric' && metadata.useTLSkins === true) projectIds.push(FABRIC_API_PROJECT_ID);
  if (projectIds.length) {
    sendInstallProgress(event, folder, { phase: 'performance-mods', status: 'Preparing selected performance and utility mods', percent: 92 });
    const compatibilityContext = { metadata };
    const installableProjects = [];
    for (const id of [...new Set(projectIds)]) {
      try {
        await findCompatibleModrinthVersionWithDependencies(id, compatibilityContext);
        installableProjects.push(id);
      } catch (error) {
        if (error.code !== 'MODRINTH_INCOMPATIBLE') throw error;
        const selectedMod = [...PERFORMANCE_MODS, ...UTILITY_MODS].find(mod => mod.id === id);
        const modName = selectedMod?.name || (id === FABRIC_API_PROJECT_ID ? 'Fabric API' : id);
        sendInstallProgress(event, folder, {
          phase: 'performance-mods',
          status: `Skipping ${modName}: ${error.message}`,
          percent: 93
        });
      }
    }
    if (installableProjects.length) {
      try {
        await installModrinthProject(event, folder, installableProjects, true);
      } catch (error) {
        if (error.code !== 'MODRINTH_INCOMPATIBLE') throw error;
        // Selected performance mods are optional. If two projects require
        // different versions of a shared dependency (commonly Sodium), retry
        // them independently so compatible selections still install and the
        // base game instance remains usable.
        for (const id of installableProjects) {
          try {
            await installModrinthProject(event, folder, id, true);
          } catch (modError) {
            if (modError.code !== 'MODRINTH_INCOMPATIBLE') throw modError;
            const selectedMod = [...PERFORMANCE_MODS, ...UTILITY_MODS].find(mod => mod.id === id);
            sendInstallProgress(event, folder, {
              phase: 'performance-mods',
              status: `Skipping ${selectedMod?.name || id}: ${modError.message}`,
              percent: 93
            });
          }
        }
      }
    }
  }
  if (loader === 'forge' && metadata.addOptiFine === true) {
    await downloadOptiFine(event, folder, instancePath, metadata.version, metadata.loaderVersion);
  }
  if (metadata.useTLSkins === true) await downloadTLSkinMod(event, folder, instancePath, metadata.version, loader);
}

async function downloadEclipseReleaseAsset(url, destination, maxBytes, onProgress) {
  const source = new URL(url);
  if (source.protocol !== 'https:' || source.hostname !== 'github.com' || !source.pathname.startsWith('/thearmangaming1234-arch/StarEclipseLauncher/releases/download/')) {
    throw new Error('The Eclipse customization download URL is invalid.');
  }
  const response = await fetch(source, { redirect: 'follow', headers: { 'User-Agent': LAUNCHER_USER_AGENT, Accept: 'application/octet-stream' } });
  const finalUrl = new URL(response.url || source.href);
  if (!response.ok || !response.body) throw new Error(`Eclipse customization download failed with HTTP ${response.status}.`);
  if (finalUrl.protocol !== 'https:' || !(finalUrl.hostname === 'github.com' || finalUrl.hostname.endsWith('.githubusercontent.com'))) {
    throw new Error('The Eclipse customization download redirected to an unexpected host.');
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > maxBytes) throw new Error('An Eclipse customization file is larger than Eclipse allows.');
  let received = 0;
  const meter = new (require('stream').Transform)({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error('An Eclipse customization file is larger than Eclipse allows.'));
      onProgress?.(received, total);
      callback(null, chunk);
    }
  });
  try {
    await require('stream/promises').pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination, { flags: 'wx' }));
    const fd = fs.openSync(destination, 'r');
    const signature = Buffer.alloc(4);
    try { fs.readSync(fd, signature, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (signature.toString('hex') !== '504b0304') throw new Error('An Eclipse customization download was not a valid ZIP archive.');
    return received;
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

async function zipHasRootEntry(filePath, expectedName) {
  return new Promise(resolve => {
    let zip = null;
    let settled = false;
    const finish = found => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { zip?.close(); } catch {}
      resolve(found);
    };
    const timeout = setTimeout(() => finish(false), 5000);
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, openedZip) => {
      if (settled) { try { openedZip?.close(); } catch {} return; }
      if (error || !openedZip) return finish(false);
      zip = openedZip;
      zip.once('error', () => finish(false));
      zip.on('entry', entry => {
        if (entry.fileName === expectedName) return finish(true);
        zip.readEntry();
      });
      zip.once('end', () => finish(false));
      zip.readEntry();
    });
  });
}

function updateSelectedResourcePacks(instancePath) {
  const optionsPath = path.join(instancePath, 'options.txt');
  let lines = [];
  try { lines = fs.readFileSync(optionsPath, 'utf8').split(/\r?\n/); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packId = `file/${ECLIPSE_ESSENTIALS_PACK_FILE}`;
  const updateList = (key, placeAtBottom = false) => {
    const lineIndex = lines.findIndex(line => line.startsWith(`${key}:`));
    let values = [];
    if (lineIndex >= 0) {
      try {
        const parsed = JSON.parse(lines[lineIndex].slice(key.length + 1));
        if (Array.isArray(parsed)) values = parsed.filter(value => typeof value === 'string');
      } catch { values = []; }
    }
    values = values.filter(value => value !== packId);
    if (placeAtBottom) values.push(packId);
    else values.unshift(packId);
    const updatedLine = `${key}:${JSON.stringify([...new Set(values)])}`;
    if (lineIndex >= 0) lines[lineIndex] = updatedLine;
    else lines.push(updatedLine);
  };
  // Minecraft gives later entries higher priority, so append Eclipse Essentials
  // to keep it above packs users install later and the vanilla assets.
  updateList('resourcePacks', true);
  // The supplied pack uses an older pack_format; marking it accepted prevents the
  // first game launch from prompting before applying Eclipse's bundled textures.
  updateList('incompatibleResourcePacks', true);
  fs.writeFileSync(optionsPath, `${lines.join('\n').replace(/\n*$/, '')}\n`, 'utf8');
}

async function ensureEclipseEssentialsPack(event, folder, instancePath, metadata) {
  const resourcePacksPath = path.join(instancePath, 'resourcepacks');
  fs.mkdirSync(resourcePacksPath, { recursive: true });
  const resourcePacksStat = fs.lstatSync(resourcePacksPath);
  if (!resourcePacksStat.isDirectory() || resourcePacksStat.isSymbolicLink()) throw new Error('The instance resource packs folder is invalid.');
  const destination = path.join(resourcePacksPath, ECLIPSE_ESSENTIALS_PACK_FILE);
  let existingPack = false;
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The Eclipse Essentials resource pack file is invalid.');
    existingPack = stat.size > 4 && await zipHasRootEntry(destination, 'pack.mcmeta');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!existingPack) {
    const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-essentials-'));
    const stagedPack = path.join(staging, ECLIPSE_ESSENTIALS_PACK_FILE);
    try {
      sendInstallProgress(event, folder, { phase: 'eclipse-customization', status: 'Downloading ECLIPSE Essentials resource pack', percent: null });
      await downloadEclipseReleaseAsset(ECLIPSE_ESSENTIALS_PACK_URL, stagedPack, 64 * 1024 * 1024, (received, total) => {
        sendInstallProgress(event, folder, { phase: 'eclipse-customization', status: 'Downloading ECLIPSE Essentials resource pack', percent: total ? Math.min(99, Math.round(received / total * 100)) : null });
      });
      fs.copyFileSync(stagedPack, destination);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  metadata.eclipseCustomization = true;
  metadata.eclipseBuiltInResourcePacks = [...new Set([...(Array.isArray(metadata.eclipseBuiltInResourcePacks) ? metadata.eclipseBuiltInResourcePacks : []), ECLIPSE_ESSENTIALS_PACK_FILE])];
  updateSelectedResourcePacks(instancePath);
  fs.writeFileSync(path.join(instancePath, 'eclipse-instance.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

async function installEclipseCustomization(event, folder, instancePath, metadata) {
  const loader = String(metadata.loader || '').toLowerCase();
  let availableMods = [];
  if (loader === 'fabric' || loader === 'forge') {
    sendInstallProgress(event, folder, { phase: 'eclipse-customization', status: 'Preparing Eclipse customization', percent: 92 });
    const compatibility = await getEclipseCustomizationOptions(metadata.version, loader);
    availableMods = compatibility.filter(mod => mod.available);
    if (availableMods.length) {
      const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-customization-config-'));
      const archive = path.join(staging, 'config.zip');
      const extracted = path.join(staging, 'extracted');
      try {
        sendInstallProgress(event, folder, { phase: 'eclipse-customization', status: 'Downloading Eclipse menu and Discord configuration', percent: null });
        const downloads = await Promise.allSettled([
          installModrinthProject(event, folder, availableMods.map(mod => mod.id), true),
          downloadEclipseReleaseAsset(ECLIPSE_CONFIG_ZIP_URL, archive, 16 * 1024 * 1024, (received, total) => {
          sendInstallProgress(event, folder, { phase: 'eclipse-customization', status: 'Downloading Eclipse menu and Discord configuration', percent: total ? Math.min(99, Math.round(received / total * 100)) : null });
          })
        ]);
        const failedDownload = downloads.find(result => result.status === 'rejected');
        if (failedDownload) throw failedDownload.reason;
        let uncompressedBytes = 0;
        await extractZip(archive, {
          dir: extracted,
          onEntry(entry) {
            const normalized = entry.fileName.replace(/\\/g, '/');
            const parts = normalized.split('/');
            if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..') || entry.fileName.includes('\\')) {
              throw new Error('The Eclipse customization config archive contains an unsafe path.');
            }
            const mode = (entry.externalFileAttributes >> 16) & 0xF000;
            if (mode === 0xA000) throw new Error('The Eclipse customization config archive contains a symbolic link.');
            uncompressedBytes += Number(entry.uncompressedSize) || 0;
            if (uncompressedBytes > 32 * 1024 * 1024) throw new Error('The Eclipse customization config archive is larger than expected.');
          }
        });
        const configPath = path.join(instancePath, 'config');
        fs.mkdirSync(configPath, { recursive: true });
        for (const mod of availableMods) {
          if (mod.slug === 'fancymenu') {
            const source = path.join(extracted, 'fancymenu');
            const stat = fs.lstatSync(source);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The Eclipse Menu configuration is missing from config.zip.');
            fs.cpSync(source, path.join(configPath, 'fancymenu'), { recursive: true, force: true });
          }
          if (mod.slug === 'craftpresence') {
            const source = path.join(extracted, 'craftpresence.json');
            const stat = fs.lstatSync(source);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('The Eclipse Discord Rich Presence config is missing from config.zip.');
            JSON.parse(fs.readFileSync(source, 'utf8'));
            fs.copyFileSync(source, path.join(configPath, 'craftpresence.json'));
          }
        }
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }

      const expectedProjects = new Set(availableMods.map(mod => mod.id));
      const registry = readModrinthRegistry(path.join(instancePath, 'mods'));
      metadata.eclipseCustomizationBuiltInMods = listJarFiles(path.join(instancePath, 'mods'))
        .map(baseJarName)
        .filter(fileName => expectedProjects.has(registry[fileName]?.projectId));
    } else {
      metadata.eclipseCustomizationBuiltInMods = [];
    }
  } else {
    metadata.eclipseCustomizationBuiltInMods = [];
  }
  await ensureEclipseEssentialsPack(event, folder, instancePath, metadata);
}

async function installJavaRuntime(component, progress) {
  const platform = runtimePlatform();
  const runtimeIndex = await fetchJson(MOJANG_RUNTIME_MANIFEST);
  const available = runtimeIndex[platform]?.[component];
  if (!Array.isArray(available) || !available.length) throw new Error(`Mojang does not provide ${component} for ${platform}.`);
  const manifestInfo = available[0];
  const runtimeManifest = await fetchJson(manifestInfo.manifest.url);
  const basePath = runtimeDirectory(component, manifestInfo.version.name);
  const javaPath = runtimeJavaPath(component, manifestInfo.version.name);
  const files = Object.entries(runtimeManifest.files || {}).filter(([, item]) => item.type === 'file');
  const tasks = files.filter(([relative, item]) => {
    if (!item.downloads?.raw) throw new Error(`Java runtime file has no download: ${relative}`);
    const destination = path.join(basePath, relative);
    return !fs.existsSync(destination) || fs.statSync(destination).size !== item.downloads.raw.size;
  });
  fs.mkdirSync(basePath, { recursive: true });
  let completed = files.length - tasks.length;
  let nextTask = 0;
  const worker = async () => {
    while (nextTask < tasks.length) {
      const [relative, item] = tasks[nextTask++];
      const destination = path.join(basePath, relative);
      const resolved = path.resolve(destination);
      if (!resolved.startsWith(`${path.resolve(basePath)}${path.sep}`)) throw new Error('Mojang runtime manifest contains an unsafe file path.');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await downloadFile(item.downloads.raw.url, destination);
      const hash = crypto.createHash('sha1').update(fs.readFileSync(destination)).digest('hex');
      if (hash !== item.downloads.raw.sha1) {
        fs.rmSync(destination, { force: true });
        throw new Error(`Java runtime verification failed for ${relative}.`);
      }
      if (process.platform !== 'win32' && item.executable) fs.chmodSync(destination, 0o755);
      completed++;
      progress({ phase: 'runtime', status: `Setting up Java ${manifestInfo.version.name}`, percent: Math.round((completed / files.length) * 100) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, worker));
  if (!fs.existsSync(javaPath)) throw new Error('Java runtime installation did not produce its launcher executable.');
  fs.writeFileSync(path.join(basePath, '.eclipse-runtime-ready.json'), JSON.stringify({
    component,
    version: manifestInfo.version.name,
    files: files.map(([relative, item]) => ({ path: relative, size: item.downloads.raw.size, sha1: item.downloads.raw.sha1 }))
  }, null, 2));
  return { javaPath, runtimeVersion: manifestInfo.version.name };
}

const MINECRAFT_VERSION_MANIFEST_URLS = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
];

async function getMinecraftVersionManifest() {
  let lastError = null;
  for (const url of MINECRAFT_VERSION_MANIFEST_URLS) {
    try {
      const manifest = await fetchJson(url);
      if (!Array.isArray(manifest.versions)) throw new Error('Mojang returned an invalid Minecraft version manifest.');
      return manifest;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not reach Mojang’s Minecraft version service. Check your internet or DNS connection and try again. ${lastError?.message || ''}`.trim());
}

async function resolveMinecraftVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Enter a valid Minecraft version number.');
  const manifest = await getMinecraftVersionManifest();
  const entry = manifest.versions?.find(item => item.id === version);
  if (!entry) throw new Error(`Minecraft ${version} is not in Mojang’s version manifest.`);
  const details = await fetchJson(entry.url);
  const majorVersion = Number(details.javaVersion?.majorVersion);
  if (!Number.isInteger(majorVersion)) throw new Error(`Mojang did not provide Java compatibility details for Minecraft ${version}.`);
  return { entry, details, majorVersion, runtimeComponent: javaRuntimeComponent(majorVersion) };
}

async function getForgeBuildForMinecraft(version, requiredBuild = '') {
  const response = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', { headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
  if (!response.ok) throw new Error(`Forge version lookup failed with HTTP ${response.status}.`);
  const metadataXml = await response.text();
  const matching = [...metadataXml.matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1]).filter(item => item.startsWith(`${version}-`));
  if (requiredBuild.startsWith('#')) {
    const legacyBuild = requiredBuild.slice(1);
    const escapedBuild = legacyBuild.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`(?:^|[.-])${escapedBuild}(?:$|[.-])`);
    return matching.find(item => matcher.test(item.slice(version.length + 1))) || '';
  }
  if (requiredBuild) return matching.find(item => item === `${version}-${requiredBuild}`) || '';
  return matching.at(-1) || '';
}

async function prepareCustomLoader(instancePath, version, loader, progress) {
  if (loader === 'vanilla') return { launchProfile: '', loaderVersion: '' };
  if (loader === 'fabric') {
    progress({ phase: 'loader', status: 'Preparing Fabric loader', percent: null });
    const available = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`);
    const selected = available.find(item => item.loader?.stable) || available[0];
    if (!selected?.loader?.version) throw new Error(`Fabric does not provide a loader for Minecraft ${version}.`);
    const profile = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(selected.loader.version)}/profile/json`);
    if (profile.inheritsFrom !== version || !Array.isArray(profile.libraries) || !/^[a-zA-Z0-9._-]+$/.test(profile.id || '')) throw new Error('Fabric returned an invalid launch profile.');
    const profileDir = path.join(instancePath, 'versions', profile.id);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, `${profile.id}.json`), JSON.stringify(profile, null, 2));
    return { launchProfile: profile.id, loaderVersion: selected.loader.version };
  }
  if (loader !== 'forge') throw new Error('Choose Vanilla, Fabric, or Forge.');

  progress({ phase: 'loader', status: 'Finding a compatible Forge installer', percent: null });
  const preferredForgeVersion = progress.preferredForgeVersion;
  const forgeVersion = typeof preferredForgeVersion === 'string' && preferredForgeVersion.startsWith(`${version}-`)
    ? preferredForgeVersion
    : await getForgeBuildForMinecraft(version);
  if (!forgeVersion) throw new Error(`Forge does not currently publish an installer for Minecraft ${version}.`);
  const installerName = `forge-${forgeVersion}-installer.jar`;
  const installerPath = path.join(app.getPath('temp'), `eclipse-${installerName}`);
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(forgeVersion)}/${installerName}`;
  await downloadFile(installerUrl, installerPath, (received, total) => progress({ phase: 'loader', status: 'Downloading Forge installer', percent: total ? Math.min(70, Math.round(received / total * 70)) : null }));
  const java = progress.runtimeJavaPath;
  if (!java) throw new Error('The Java runtime is not ready for the Forge installer.');
  // Forge's client installer refuses to install into a fresh game directory unless
  // the official launcher has already created launcher_profiles.json. Eclipse owns
  // this isolated instance directory, so provide the minimal profile container the
  // installer expects instead of asking users to launch another launcher first.
  const launcherProfilesPath = path.join(instancePath, 'launcher_profiles.json');
  if (!fs.existsSync(launcherProfilesPath)) {
    fs.writeFileSync(launcherProfilesPath, JSON.stringify({ profiles: {}, settings: {} }, null, 2), 'utf8');
  }
  progress({ phase: 'loader', status: 'Installing Forge libraries', percent: null });
  await new Promise((resolve, reject) => {
    const child = spawn(runtimeJavaProbePath(progress.runtimeComponent, progress.runtimeVersion), ['-jar', installerPath, '--installClient', instancePath], { cwd: instancePath, windowsHide: true });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Forge installation took too long and was stopped.')); }, 10 * 60 * 1000);
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-12000); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-12000); });
    child.once('error', error => { clearTimeout(timeout); reject(new Error(`Could not start Forge installer: ${error.message}`)); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Forge installer exited with code ${code}.${output.trim() ? ` ${output.trim().slice(-1200)}` : ''}`));
    });
  }).finally(() => fs.rmSync(installerPath, { force: true }));
  const versionsDir = path.join(instancePath, 'versions');
  const forgeProfile = fs.readdirSync(versionsDir, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => {
    const jsonPath = path.join(versionsDir, item.name, `${item.name}.json`);
    try { return { id: item.name, json: JSON.parse(fs.readFileSync(jsonPath, 'utf8')) }; } catch { return null; }
  }).find(item => item && item.json.inheritsFrom === version && /(?:^|-)forge-/i.test(item.id));
  if (!forgeProfile) throw new Error('Forge finished without creating its Minecraft launch profile.');
  return { launchProfile: forgeProfile.id, loaderVersion: forgeVersion.slice(version.length + 1) };
}

async function installCustomInstance(event, folder) {
  const { instancePath, metadata } = getInstanceMetadata(folder);
  if (metadata.customInstance !== true) throw new Error('This instance does not have a supported installer.');
  if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder)) throw new Error('This instance is already installing or changing mods.');
  activeInstanceInstalls.add(folder);
  try {
    const { entry, details, majorVersion, runtimeComponent } = await resolveMinecraftVersion(metadata.version);
    sendInstallProgress(event, folder, { phase: 'runtime', status: 'Setting up the required Java runtime', percent: 0 });
    for (const directory of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'versions']) fs.mkdirSync(path.join(instancePath, directory), { recursive: true });
    const selectedLoader = String(metadata.loader || 'Vanilla').toLowerCase();
    const prepareLoader = runtime => prepareCustomLoader(instancePath, metadata.version, selectedLoader, Object.assign(
      update => sendInstallProgress(event, folder, update),
      { runtimeJavaPath: runtime?.javaPath, runtimeComponent, runtimeVersion: runtime?.runtimeVersion, preferredForgeVersion: metadata.addOptiFine ? metadata.optifineForgeVersion : '' }
    ));
    let runtime;
    let loaderInfo;
    if (selectedLoader === 'forge') {
      runtime = await installJavaRuntime(runtimeComponent, update => sendInstallProgress(event, folder, update));
      loaderInfo = await prepareLoader(runtime);
    } else {
      const [runtimeResult, loaderResult] = await Promise.allSettled([
        installJavaRuntime(runtimeComponent, update => sendInstallProgress(event, folder, update)),
        prepareLoader(null)
      ]);
      if (runtimeResult.status === 'rejected') throw runtimeResult.reason;
      if (loaderResult.status === 'rejected') throw loaderResult.reason;
      runtime = runtimeResult.value;
      loaderInfo = loaderResult.value;
    }
    const updated = {
      ...metadata,
      loader: String(metadata.loader || 'Vanilla').replace(/^./, letter => letter.toUpperCase()),
      launchProfile: loaderInfo.launchProfile || undefined,
      loaderVersion: loaderInfo.loaderVersion || undefined,
      runtimeComponent,
      runtimeVersion: runtime.runtimeVersion,
      javaMajorVersion: majorVersion,
      versionType: entry.type,
      builtInMods: [],
      createdBy: 'user'
    };
    fs.writeFileSync(path.join(instancePath, 'eclipse-instance.json'), JSON.stringify(updated, null, 2));
    const marker = path.join(instancePath, 'downloaded.txt');
    fs.rmSync(marker, { force: true });
    const setupResults = await Promise.allSettled([
      downloadMinecraftDependencies(event, folder, instancePath, updated),
      installPerformanceMods(event, folder, instancePath, updated)
    ]);
    const setupFailure = setupResults.find(result => result.status === 'rejected');
    if (setupFailure) throw setupFailure.reason;
    await installEclipseCustomization(event, folder, instancePath, updated);
    fs.writeFileSync(marker, 'Custom instance runtime and loader installed by Eclipse Launcher.\n');
    if (!isInstanceInstalled(folder, updated)) {
      fs.rmSync(marker, { force: true });
      throw new Error('The instance did not pass its final installation checks.');
    }
    sendInstallProgress(event, folder, { phase: 'complete', status: 'Installation complete', percent: 100 });
    return { ok: true, folder, gameVersion: details.id };
  } catch (error) {
    sendInstallProgress(event, folder, { phase: 'error', status: error.message || 'Installation failed', percent: null });
    throw error;
  } finally { activeInstanceInstalls.delete(folder); }
}

async function installInstance(event, folder) {
  if (typeof folder !== 'string' || path.basename(folder) !== folder) throw new Error('That Minecraft instance could not be found.');
  if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder)) throw new Error('This instance is already installing or changing mods.');
  const instancePath = path.join(instancesDir, folder);
  if (!fs.existsSync(instancePath) || !fs.statSync(instancePath).isDirectory()) throw new Error('That Minecraft instance could not be found.');
  const { metadata } = getInstanceMetadata(folder);
  const release = getInstanceRelease(folder, metadata);
  if (!release) throw new Error('There is no installer configured for this instance.');
  if (metadata.customInstance === true && !INSTANCE_RELEASES[folder] && !metadata.eclipseReleaseKey) return installCustomInstance(event, folder);
  const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-instance-'));
  const archive = path.join(staging, 'instance.zip');
  const extracted = path.join(staging, 'extracted');
  activeInstanceInstalls.add(folder);
  const runtimeComponent = release.version === '26.2' ? 'java-runtime-epsilon' : 'java-runtime-gamma';
  sendInstallProgress(event, folder, { phase: 'runtime', status: 'Setting up the required Java runtime', percent: 0 });
  const runtimeTask = installJavaRuntime(runtimeComponent, update => sendInstallProgress(event, folder, update))
    .then(runtime => ({ runtime }), error => ({ error }));
  const fabricProfileTask = fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(release.version)}/${encodeURIComponent(release.fabricLoader)}/profile/json`)
    .then(fabricProfile => ({ fabricProfile }), error => ({ error }));
  try {
    sendInstallProgress(event, folder, { phase: 'download', status: 'Downloading instance files', percent: 0 });
    await downloadFile(release.url, archive, (received, total) => {
      sendInstallProgress(event, folder, { phase: 'download', status: 'Downloading instance files', percent: total ? Math.min(100, Math.round(received / total * 100)) : null, received, total });
    });
    sendInstallProgress(event, folder, { phase: 'extract', status: 'Checking and extracting files', percent: null });
    await extractZip(archive, {
      dir: extracted,
      onEntry(entry) {
        const normalized = entry.fileName.replace(/\\/g, '/');
        const parts = normalized.split('/');
        if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..') || entry.fileName.includes('\\')) {
          throw new Error(`The instance archive contains an unsafe file path: ${entry.fileName}`);
        }
        const mode = (entry.externalFileAttributes >> 16) & 0xF000;
        if (mode === 0xA000) throw new Error('The instance archive contains an unsupported symbolic link.');
      }
    });

    const modsPath = path.join(extracted, 'mods');
    const configPath = path.join(extracted, 'config');
    const hasArchiveMarker = fs.existsSync(path.join(extracted, 'downloaded.txt'));
    if (!hasArchiveMarker || !fs.existsSync(modsPath) || !fs.statSync(modsPath).isDirectory() || !hasModJar(extracted) || !hasContentFile(configPath)) {
      throw new Error('The downloaded pack is incomplete. It needs downloaded.txt, at least one mod, and config files.');
    }

    sendInstallProgress(event, folder, { phase: 'fabric', status: 'Preparing Fabric profile', percent: null });
    const fabricProfileResult = await fabricProfileTask;
    if (fabricProfileResult.error) throw fabricProfileResult.error;
    const fabricProfile = fabricProfileResult.fabricProfile;
    if (fabricProfile.id !== release.launchProfile || fabricProfile.inheritsFrom !== release.version || !Array.isArray(fabricProfile.libraries)) {
      throw new Error('Fabric returned an unexpected launch profile.');
    }
    const profileDir = path.join(extracted, 'versions', release.launchProfile);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, `${release.launchProfile}.json`), JSON.stringify(fabricProfile, null, 2), 'utf8');

    const runtimeResult = await runtimeTask;
    if (runtimeResult.error) throw runtimeResult.error;
    const runtime = runtimeResult.runtime;

    sendInstallProgress(event, folder, { phase: 'finalize', status: 'Finishing instance setup', percent: null });
    await fs.promises.cp(extracted, instancePath, {
      recursive: true,
      force: false,
      filter(source) { return path.basename(source).toLowerCase() !== 'eclipse-instance.json'; }
    });
    const metadataPath = path.join(instancePath, 'eclipse-instance.json');
    const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {};
    const finalProfilePath = path.join(instancePath, 'versions', release.launchProfile, `${release.launchProfile}.json`);
    fs.mkdirSync(path.dirname(finalProfilePath), { recursive: true });
    fs.copyFileSync(path.join(profileDir, `${release.launchProfile}.json`), finalProfilePath);
    const installedMetadata = { ...metadata, version: release.version, loader: 'Fabric', launchProfile: release.launchProfile, runtimeComponent, runtimeVersion: runtime.runtimeVersion, builtInMods: listJarFiles(path.join(extracted, 'mods')).map(baseJarName) };
    fs.writeFileSync(metadataPath, JSON.stringify(installedMetadata, null, 2));
    const markerPath = path.join(instancePath, 'downloaded.txt');
    fs.rmSync(markerPath, { force: true });
    const setupResults = await Promise.allSettled([
      downloadMinecraftDependencies(event, folder, instancePath, installedMetadata),
      ensureEclipseEssentialsPack(event, folder, instancePath, installedMetadata)
    ]);
    const setupFailure = setupResults.find(result => result.status === 'rejected');
    if (setupFailure) throw setupFailure.reason;
    fs.writeFileSync(markerPath, 'Installed and verified by Eclipse Launcher.\n', 'utf8');
    if (!isInstanceInstalled(folder, installedMetadata)) {
      fs.rmSync(markerPath, { force: true });
      throw new Error('The instance did not pass its final installation checks.');
    }
    sendInstallProgress(event, folder, { phase: 'complete', status: 'Installation complete', percent: 100 });
    return { ok: true, folder };
  } catch (error) {
    sendInstallProgress(event, folder, { phase: 'error', status: error.message || 'Installation failed', percent: null });
    throw error;
  } finally {
    await Promise.all([runtimeTask, fabricProfileTask]);
    activeInstanceInstalls.delete(folder);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function readJsonIfPresent(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

async function detectModLoaderFromJars(gameRoot) {
  const modsPath = path.join(gameRoot, 'mods');
  let jars = [];
  try { jars = fs.readdirSync(modsPath, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map(entry => path.join(modsPath, entry.name)); } catch {}
  // Loader metadata is present in the majority of mods. Bound the scan so a
  // large custom mods folder cannot make importing feel unresponsive.
  for (const jarPath of jars.slice(0, 40)) {
    const detected = await new Promise(resolve => {
      yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (error, zip) => {
        if (error || !zip) return resolve('');
        let finished = false;
        const finish = value => { if (finished) return; finished = true; resolve(value); };
        zip.on('error', () => finish(''));
        zip.on('entry', entry => {
          const name = entry.fileName.replace(/\\/g, '/').toLowerCase();
          if (name === 'fabric.mod.json') return finish('fabric');
          if (name === 'meta-inf/mods.toml' || name === 'meta-inf/neoforge.mods.toml') return finish('forge');
          zip.readEntry();
        });
        zip.on('end', () => finish(''));
        zip.readEntry();
      });
    });
    if (detected) return detected;
  }
  return '';
}

async function inspectImportedModpack(folderPath) {
  let gameRoot = folderPath;
  if (!fs.existsSync(path.join(gameRoot, 'versions'))) {
    for (const nested of ['.minecraft', 'minecraft', 'game']) {
      const candidate = path.join(folderPath, nested);
      if (fs.existsSync(path.join(candidate, 'versions')) || fs.existsSync(path.join(candidate, 'mods'))) { gameRoot = candidate; break; }
    }
  }
  const existingMetadata = readJsonIfPresent(path.join(gameRoot, 'eclipse-instance.json')) || {};
  let version = String(existingMetadata.version || '');
  let loader = String(existingMetadata.loader || '').toLowerCase();
  let launchProfile = String(existingMetadata.launchProfile || '');
  let versionType = String(existingMetadata.versionType || '');
  const candidates = [];
  const versionsPath = path.join(gameRoot, 'versions');
  try {
    for (const entry of fs.readdirSync(versionsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || path.basename(entry.name) !== entry.name) continue;
      const profile = readJsonIfPresent(path.join(versionsPath, entry.name, `${entry.name}.json`));
      if (!profile) continue;
      const inheritedVersion = String(profile.inheritsFrom || profile.id || entry.name);
      const candidateVersion = String(profile.inheritsFrom || (profile.id === entry.name ? profile.id : ''));
      if (!/^\d+\.\d+(?:\.\d+)?$/.test(candidateVersion)) continue;
      const profileId = String(profile.id || entry.name);
      const detectedLoader = /fabric/i.test(profileId) || /net\.fabricmc\.loader/i.test(profile.mainClass || '') ? 'fabric'
        : /neoforge/i.test(profileId) || /neoforge/i.test(profile.mainClass || '') ? 'neoforge'
          : /forge/i.test(profileId) || /modlauncher/i.test(profile.mainClass || '') ? 'forge' : 'vanilla';
      candidates.push({ profileId, version: candidateVersion || inheritedVersion, loader: detectedLoader, versionType: profile.type || versionType, hasParent: Boolean(profile.inheritsFrom) });
    }
  } catch {}

  const mmcPack = readJsonIfPresent(path.join(gameRoot, 'mmc-pack.json'));
  if (mmcPack && Array.isArray(mmcPack.components)) {
    const game = mmcPack.components.find(item => item.uid === 'net.minecraft');
    if (!version && game?.version) version = String(game.version);
    const fabric = mmcPack.components.find(item => /fabric-loader/i.test(item.uid || ''));
    const neoForge = mmcPack.components.find(item => /neoforge/i.test(item.uid || ''));
    const forge = mmcPack.components.find(item => /forge/i.test(item.uid || ''));
    if (!loader || loader === 'unknown') loader = fabric ? 'fabric' : neoForge ? 'neoforge' : forge ? 'forge' : 'vanilla';
  }
  const manifest = readJsonIfPresent(path.join(gameRoot, 'manifest.json'));
  if (manifest?.minecraft?.version) {
    if (!version) version = String(manifest.minecraft.version);
    const modLoader = manifest.minecraft.modLoaders?.find(item => item.primary)?.id || manifest.minecraft.modLoaders?.[0]?.id || '';
    if (!loader || loader === 'unknown') loader = /fabric/i.test(modLoader) ? 'fabric' : /neoforge/i.test(modLoader) ? 'neoforge' : /forge/i.test(modLoader) ? 'forge' : 'vanilla';
  }
  const modrinthIndex = readJsonIfPresent(path.join(gameRoot, 'modrinth.index.json'));
  if (modrinthIndex) {
    const dependencies = modrinthIndex.dependencies || {};
    const loaderKeys = Object.keys(dependencies);
    if (!version && dependencies.minecraft) version = String(dependencies.minecraft);
    if (!loader || loader === 'unknown') {
      loader = loaderKeys.some(key => /^fabric-loader$/i.test(key)) ? 'fabric'
        : loaderKeys.some(key => /^neoforge$/i.test(key)) ? 'neoforge'
          : loaderKeys.some(key => /^forge$/i.test(key)) ? 'forge' : 'vanilla';
    }
  }

  if (launchProfile) {
    const importedProfile = readJsonIfPresent(path.join(versionsPath, launchProfile, `${launchProfile}.json`));
    if (importedProfile) {
      version ||= String(importedProfile.inheritsFrom || importedProfile.id || '');
      loader ||= /fabric/i.test(launchProfile) ? 'fabric' : /neoforge/i.test(launchProfile) ? 'neoforge' : /forge/i.test(launchProfile) ? 'forge' : 'vanilla';
    } else launchProfile = '';
  }

  if (!version || !loader || loader === 'unknown' || loader === 'custom') {
    const ranked = candidates.sort((a, b) => Number(b.hasParent) - Number(a.hasParent));
    const selected = ranked.find(item => !loader || loader === 'unknown' || item.loader === loader) || ranked[0];
    if (selected) {
      version ||= selected.version;
      if (!loader || loader === 'unknown') loader = selected.loader;
      if (selected.hasParent && (!loader || selected.loader === loader)) launchProfile ||= selected.profileId;
      versionType ||= selected.versionType;
    }
  }
  if (!version) {
    const versionsFromMods = new Set();
    try {
      for (const item of fs.readdirSync(path.join(gameRoot, 'mods'), { withFileTypes: true })) {
        if (!item.isFile() || !item.name.toLowerCase().endsWith('.jar')) continue;
        for (const match of item.name.matchAll(/(?:^|[-_.+])(?:mc|minecraft)[-_. ]?(\d+\.\d+(?:\.\d+)?)(?=$|[-_.+])/gi)) versionsFromMods.add(match[1]);
      }
    } catch {}
    if (versionsFromMods.size === 1) version = [...versionsFromMods][0];
  }
  if (!version) {
    const folderVersion = path.basename(folderPath).match(/^(\d+\.\d+(?:\.\d+)?)(?:[-_ ].*)?$/);
    if (folderVersion) version = folderVersion[1];
  }
  if (!loader || loader === 'unknown' || loader === 'custom') loader = await detectModLoaderFromJars(gameRoot);
  let hasModJars = false;
  try { hasModJars = fs.readdirSync(path.join(gameRoot, 'mods'), { withFileTypes: true }).some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')); } catch {}
  if ((!loader || loader === 'unknown') && version && !candidates.length && !hasModJars) loader = 'vanilla';
  if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(loader)) throw new Error('Could not identify whether this modpack uses Vanilla, Fabric, Forge, or NeoForge.');
  if (loader === 'neoforge' && !launchProfile) throw new Error('This NeoForge pack does not include an installed NeoForge launch profile. Import a fully installed instance folder.');
  if (loader !== 'vanilla' && !launchProfile) {
    const profile = candidates.find(item => item.loader === loader && item.hasParent && item.version === version);
    if (profile) launchProfile = profile.profileId;
    // Many modpack folders contain only mods/config and no launcher-generated
    // versions profile. The importer installs a matching loader profile after
    // copying the pack, so this is a supported case rather than a detection error.
  }
  if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Could not identify a Minecraft version in this modpack. Include its installed versions folder or launcher profile.');
  if (launchProfile && !/^[a-zA-Z0-9._-]+$/.test(launchProfile)) throw new Error('The modpack contains an invalid loader profile name.');
  return { gameRoot, existingMetadata, version, loader, launchProfile, versionType };
}

function importedPackHasFancyMenu(instancePath) {
  const modsPath = path.join(instancePath, 'mods');
  const registry = readModrinthRegistry(modsPath);
  const fancyMenu = ECLIPSE_CUSTOMIZATION_MODS.find(mod => mod.slug === 'fancymenu');
  if (Object.values(registry).some(mod => mod?.projectId === fancyMenu.id || String(mod?.slug || '').toLowerCase() === 'fancymenu')) return true;
  return listJarFiles(modsPath).some(fileName => normalizeModIdentity(baseJarName(fileName)).includes('fancymenu'));
}

async function addEclipseThemeToImportedPack(folder, instancePath, metadata) {
  if (importedPackHasFancyMenu(instancePath)) {
    metadata.eclipseCustomization = true;
    return 'already-present';
  }
  const loader = String(metadata.loader || '').toLowerCase();
  if (!['fabric', 'forge'].includes(loader)) {
    metadata.eclipseCustomization = false;
    return 'unavailable';
  }
  const fancyMenu = ECLIPSE_CUSTOMIZATION_MODS.find(mod => mod.slug === 'fancymenu');
  try { await findCompatibleModrinthVersionWithDependencies(fancyMenu.id, { metadata }); }
  catch (error) {
    if (error.code !== 'MODRINTH_INCOMPATIBLE') throw error;
    metadata.eclipseCustomization = false;
    return 'unavailable';
  }

  const installed = await installModrinthProject(null, folder, fancyMenu.id, false);
  if (!installed.installedCount) {
    metadata.eclipseCustomization = true;
    return 'already-present';
  }

  const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-import-theme-'));
  try {
    const archive = path.join(staging, 'config.zip');
    const extracted = path.join(staging, 'extracted');
    await downloadEclipseReleaseAsset(ECLIPSE_CONFIG_ZIP_URL, archive, 16 * 1024 * 1024);
    let uncompressedBytes = 0;
    await extractZip(archive, {
      dir: extracted,
      onEntry(entry) {
        const normalized = entry.fileName.replace(/\\/g, '/');
        const parts = normalized.split('/');
        if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || parts.includes('..') || entry.fileName.includes('\\')) {
          throw new Error('The Eclipse customization config archive contains an unsafe path.');
        }
        const mode = (entry.externalFileAttributes >> 16) & 0xF000;
        if (mode === 0xA000) throw new Error('The Eclipse customization config archive contains a symbolic link.');
        uncompressedBytes += Number(entry.uncompressedSize) || 0;
        if (uncompressedBytes > 32 * 1024 * 1024) throw new Error('The Eclipse customization config archive is larger than expected.');
      }
    });
    const source = path.join(extracted, 'fancymenu');
    const stat = fs.lstatSync(source);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The Eclipse Menu configuration is missing from config.zip.');
    const configPath = path.join(instancePath, 'config');
    fs.mkdirSync(configPath, { recursive: true });
    fs.cpSync(source, path.join(configPath, 'fancymenu'), { recursive: true, force: true });
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }

  metadata.eclipseCustomization = true;
  const registry = readModrinthRegistry(path.join(instancePath, 'mods'));
  const importedBuiltIns = listJarFiles(path.join(instancePath, 'mods'))
    .map(baseJarName)
    .filter(fileName => registry[fileName]?.projectId === fancyMenu.id);
  metadata.eclipseCustomizationBuiltInMods = [...new Set([
    ...(Array.isArray(metadata.eclipseCustomizationBuiltInMods) ? metadata.eclipseCustomizationBuiltInMods : []),
    ...importedBuiltIns
  ])];
  await ensureEclipseEssentialsPack(null, folder, instancePath, metadata);
  return 'added';
}

async function importModpackFolder(sourcePath, importMode, addEclipseTheme = true) {
  const source = path.resolve(sourcePath);
  const sourceStat = fs.lstatSync(source);
  const isZip = sourceStat.isFile() && path.extname(source).toLowerCase() === '.zip';
  if ((!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) && !isZip) throw new Error('Choose a modpack folder or .zip file.');
  const instancesRoot = path.resolve(instancesDir);
  if (source === instancesRoot || source.startsWith(`${instancesRoot}${path.sep}`)) throw new Error('Choose a modpack folder outside Eclipse’s instances folder.');
  let extractionRoot = '';
  let importRoot = source;
  if (isZip) {
    extractionRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-modpack-'));
    try { await extractZip(source, { dir: extractionRoot }); }
    catch (error) { await fs.promises.rm(extractionRoot, { recursive: true, force: true }); throw new Error(`Could not open this modpack ZIP: ${error.message}`); }
    importRoot = extractionRoot;
  }
  let inspected;
  try { inspected = await inspectImportedModpack(importRoot); }
  catch (error) { if (extractionRoot) await fs.promises.rm(extractionRoot, { recursive: true, force: true }); throw error; }
  let entry, majorVersion, runtimeComponent, runtime;
  try {
    ({ entry, majorVersion, runtimeComponent } = await resolveMinecraftVersion(inspected.version));
    runtime = await installJavaRuntime(runtimeComponent, () => {});
  } catch (error) {
    if (extractionRoot) await fs.promises.rm(extractionRoot, { recursive: true, force: true });
    throw error;
  }
  const displayName = path.basename(source, isZip ? path.extname(source) : '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'Imported Modpack';
  const folder = safeInstanceFolder(displayName);
  const destination = path.join(instancesRoot, folder);
  if (fs.existsSync(destination)) { if (extractionRoot) await fs.promises.rm(extractionRoot, { recursive: true, force: true }); throw new Error(`An instance named “${displayName}” already exists. Rename the source folder and try again.`); }
  fs.mkdirSync(instancesRoot, { recursive: true });
  let copied = false;
  let movedSource = false;
  try {
    if (importMode === 'move' && !isZip) {
      try { await fs.promises.rename(inspected.gameRoot, destination); movedSource = true; }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fs.promises.cp(inspected.gameRoot, destination, { recursive: true, errorOnExist: true, force: false });
        copied = true;
      }
    } else {
      await fs.promises.cp(inspected.gameRoot, destination, { recursive: true, errorOnExist: true, force: false });
      copied = true;
    }
    for (const directory of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'versions']) fs.mkdirSync(path.join(destination, directory), { recursive: true });
    if (inspected.loader !== 'vanilla' && !inspected.launchProfile) {
      const loaderProgress = Object.assign(() => {}, {
        runtimeJavaPath: runtime.javaPath,
        runtimeComponent,
        runtimeVersion: runtime.runtimeVersion
      });
      const loaderInfo = await prepareCustomLoader(destination, inspected.version, inspected.loader, loaderProgress);
      inspected.launchProfile = loaderInfo.launchProfile;
    }
    if (inspected.launchProfile) {
      const profile = readJsonIfPresent(path.join(destination, 'versions', inspected.launchProfile, `${inspected.launchProfile}.json`));
      if (!profile || profile.inheritsFrom !== inspected.version) throw new Error('The imported loader profile does not match its Minecraft version.');
    }
    const metadata = {
      ...inspected.existingMetadata,
      name: displayName,
      version: inspected.version,
      loader: inspected.loader[0].toUpperCase() + inspected.loader.slice(1),
      icon: typeof inspected.existingMetadata.icon === 'string' ? inspected.existingMetadata.icon : '',
      customInstance: true,
      createdBy: 'imported',
      importedAt: Date.now(),
      lastPlayed: Number(inspected.existingMetadata.lastPlayed) || 0,
      playtimeMs: Math.max(0, Number(inspected.existingMetadata.playtimeMs) || 0),
      launchProfile: inspected.launchProfile,
      runtimeComponent,
      runtimeVersion: runtime.runtimeVersion,
      javaMajorVersion: majorVersion,
      versionType: inspected.versionType || entry.type,
      builtInMods: Array.isArray(inspected.existingMetadata.builtInMods) ? inspected.existingMetadata.builtInMods : []
    };
    fs.writeFileSync(path.join(destination, 'eclipse-instance.json'), JSON.stringify(metadata, null, 2), 'utf8');
    fs.writeFileSync(path.join(destination, 'downloaded.txt'), 'Imported and prepared by Eclipse Launcher.\n', 'utf8');
    const eclipseThemeStatus = addEclipseTheme
      ? await addEclipseThemeToImportedPack(folder, destination, metadata)
      : (metadata.eclipseCustomization = false, 'disabled');
    fs.writeFileSync(path.join(destination, 'eclipse-instance.json'), JSON.stringify(metadata, null, 2), 'utf8');
    if (!isInstanceInstalled(folder, metadata)) throw new Error('The imported folder is missing a required Minecraft profile or runtime file.');
    let sourceRetained = false;
    if (importMode === 'move' && isZip) {
      try { await fs.promises.rm(source, { force: false, maxRetries: 3, retryDelay: 150 }); }
      catch { sourceRetained = true; }
    } else if (importMode === 'move' && copied && inspected.gameRoot === source) {
      try { await fs.promises.rm(source, { recursive: true, force: false, maxRetries: 3, retryDelay: 150 }); }
      catch { sourceRetained = true; }
    } else if (importMode === 'move' && inspected.gameRoot !== source && fs.existsSync(source)) {
      try { await fs.promises.rm(source, { recursive: true, force: false, maxRetries: 3, retryDelay: 150 }); }
      catch { sourceRetained = true; }
    }
    return { ...metadata, folder, installed: true, sourceRetained, eclipseThemeStatus };
  } catch (error) {
    if (movedSource && fs.existsSync(destination) && !fs.existsSync(source)) {
      try { await fs.promises.rename(destination, source); }
      catch { throw new Error(`Import failed and Eclipse could not move the folder back. Your modpack is at ${destination}. ${error.message}`); }
    } else if (fs.existsSync(destination)) {
      await fs.promises.rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    }
    throw error;
  } finally {
    if (extractionRoot) await fs.promises.rm(extractionRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
  }
}
function ensureDirs() {
  fs.mkdirSync(instancesDir, { recursive: true });
  if (!isDev) {
    const bundledInstances = path.join(appRoot, 'instances');
    if (fs.existsSync(bundledInstances)) {
      for (const entry of fs.readdirSync(bundledInstances, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const destination = path.join(instancesDir, entry.name);
        copyMissingBundledFiles(path.join(bundledInstances, entry.name), destination);
      }
    }
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const defaultBackgroundAvailable = ensureDefaultBackgroundAsset();
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      profile: { mode: 'offline', name: 'Steve', status: 'online' },
      profiles: [{ id: 'offline-default', type: 'offline', mode: 'offline', name: 'Steve', status: 'online' }],
      selectedProfileId: 'offline-default',
      lastAccountType: 'microsoft',
      animationSpeed: 'normal',
      playAnimationSpeed: 'relaxed',
      quickLaunchLevel: 'min',
      launchAction: 'hide',
      memoryAllocationMb: getRecommendedMemoryAllocationMb(),
      minecraftResolutionWidth: 1280,
      minecraftResolutionHeight: 720,
      minecraftFullscreen: false,
      showPlaytime: true,
      playtimePosition: 'left',
      showFriendsBox: true,
      showQuickLaunch: true,
      performanceModsEnabledByDefault: false,
      utilityModsEnabledByDefault: false,
      useTLSkinsEnabledByDefault: false,
      newsEnabled: true,
      sidebarOrder: ['home', 'mods', 'profile', 'settings'],
      pinnedInstances: [],
      theme: 'dark',
      background: defaultBackgroundAvailable ? defaultBackgroundPath : null,
      installedInstances: {}
    }, null, 2));
  } else if (defaultBackgroundAvailable) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (typeof settings.background !== 'string' || !settings.background.trim()) {
        settings.background = defaultBackgroundPath;
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
      }
    } catch {}
  }
}

function ensureDefaultBackgroundAsset() {
  try {
    const existing = fs.lstatSync(defaultBackgroundPath);
    return existing.isFile() && !existing.isSymbolicLink();
  } catch (error) { if (error.code !== 'ENOENT') return false; }
  try {
    const sourceStat = fs.lstatSync(defaultBackgroundSource);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 8) return false;
    const contents = fs.readFileSync(defaultBackgroundSource);
    if (!contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
    fs.mkdirSync(path.dirname(defaultBackgroundPath), { recursive: true });
    fs.writeFileSync(defaultBackgroundPath, contents, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        const existing = fs.lstatSync(defaultBackgroundPath);
        return existing.isFile() && !existing.isSymbolicLink();
      } catch {}
    }
    appendLauncherLog('Background', `Could not prepare the bundled default background: ${error.message || error}`);
    return false;
  }
}

function readSettings() {
  ensureDirs();
  try { return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); }
  catch { return normalizeSettings({ profile: { mode: 'offline', name: 'Steve', status: 'online' }, theme: 'dark', background: null, installedInstances: {} }); }
}

function writeSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(normalizeSettings(settings), null, 2));
}

function normalizeSettings(settings = {}) {
  const storedProfiles = Array.isArray(settings.profiles) ? settings.profiles.filter(profile => profile && typeof profile.id === 'string') : [];
  const profiles = storedProfiles.length ? storedProfiles : [{
    id: 'offline-default',
    type: 'offline',
    mode: 'offline',
    name: settings.profile?.name || 'Steve',
    status: settings.profile?.status || 'online'
  }];
  const requestedId = settings.selectedProfileId || settings.profile?.id;
  const selected = profiles.find(profile => profile.id === requestedId) || profiles[0];
  const normalizedProfiles = profiles.map(profile => ({ ...profile, note: typeof profile.note === 'string' ? profile.note : '', mode: profile.type === 'microsoft' ? 'microsoft' : 'offline' }));
  const selectedProfile = normalizedProfiles.find(profile => profile.id === selected.id) || normalizedProfiles[0];
  const animationSpeeds = new Set(['fast', 'normal', 'relaxed', 'slow', 'off']);
  const animationSpeed = animationSpeeds.has(settings.animationSpeed) ? settings.animationSpeed : 'normal';
  const playAnimationSpeed = animationSpeeds.has(settings.playAnimationSpeed) ? settings.playAnimationSpeed : 'relaxed';
  const launchActions = new Set(['minimize', 'close', 'hide', 'nothing']);
  const launchAction = launchActions.has(settings.launchAction) ? settings.launchAction : 'hide';
  const lastAccountType = settings.lastAccountType === 'offline' ? 'offline' : 'microsoft';
  const memoryAllocationMaxMb = getMaximumMemoryAllocationMb();
  const requestedMemoryMb = Number(settings.memoryAllocationMb);
  const memoryAllocationMb = Number.isFinite(requestedMemoryMb)
    ? Math.max(1024, Math.min(memoryAllocationMaxMb, Math.round(requestedMemoryMb / 512) * 512))
    : getRecommendedMemoryAllocationMb(memoryAllocationMaxMb);
  const minecraftResolutionWidth = normalizeResolutionDimension(settings.minecraftResolutionWidth, 1280, 320, 7680);
  const minecraftResolutionHeight = normalizeResolutionDimension(settings.minecraftResolutionHeight, 720, 240, 4320);
  const minecraftFullscreen = settings.minecraftFullscreen === true;
  const showPlaytime = settings.showPlaytime !== false;
  const playtimePosition = settings.playtimePosition === 'right' ? 'right' : 'left';
  const showFriendsBox = typeof settings.showFriendsBox === 'boolean'
    ? settings.showFriendsBox
    : settings.hideFriendsBox !== true;
  const showQuickLaunch = settings.showQuickLaunch !== false;
  const performanceModsEnabledByDefault = settings.performanceModsEnabledByDefault === true;
  const utilityModsEnabledByDefault = settings.utilityModsEnabledByDefault === true;
  const useTLSkinsEnabledByDefault = settings.useTLSkinsEnabledByDefault === true;
  const sidebarPages = ['home', 'mods', 'profile', 'settings'];
  const accentColor = /^#[0-9a-f]{6}$/i.test(settings.accentColor) ? settings.accentColor.toLowerCase() : '#963cff';
  const glassStrength = Number.isFinite(Number(settings.glassStrength)) ? Math.max(0, Math.min(100, Math.round(Number(settings.glassStrength)))) : 62;
  const backgroundBlur = Number.isFinite(Number(settings.backgroundBlur)) ? Math.max(0, Math.min(32, Math.round(Number(settings.backgroundBlur)))) : 16;
  const performanceMode = settings.performanceMode === true;
  const quickLaunchLevel = ['off', 'min', 'max'].includes(settings.quickLaunchLevel) ? settings.quickLaunchLevel : 'min';
  const requestedSidebarOrder = Array.isArray(settings.sidebarOrder) ? settings.sidebarOrder.filter(page => sidebarPages.includes(page)) : [];
  const sidebarOrder = [...new Set(requestedSidebarOrder), ...sidebarPages.filter(page => !requestedSidebarOrder.includes(page))];
  const newsEnabled = settings.newsEnabled !== false;
  const pinnedInstances = Array.isArray(settings.pinnedInstances) ? [...new Set(settings.pinnedInstances.filter(folder => typeof folder === 'string'))] : [];
  const modsInstanceFolder = typeof settings.modsInstanceFolder === 'string' ? settings.modsInstanceFolder : '';
  return { ...settings, theme: 'dark', accentColor, glassStrength, backgroundBlur, performanceMode, quickLaunchLevel, animationSpeed, playAnimationSpeed, launchAction, lastAccountType, memoryAllocationMb, memoryAllocationMaxMb, minecraftResolutionWidth, minecraftResolutionHeight, minecraftFullscreen, showPlaytime, playtimePosition, showFriendsBox, showQuickLaunch, performanceModsEnabledByDefault, utilityModsEnabledByDefault, useTLSkinsEnabledByDefault, newsEnabled, sidebarOrder, pinnedInstances, modsInstanceFolder, profiles: normalizedProfiles, selectedProfileId: selectedProfile.id, profile: selectedProfile };
}

function getMaximumMemoryAllocationMb() {
  const totalMemoryMb = Math.floor(os.totalmem() / (1024 * 1024));
  // Leave at least 2 GB for Windows and other apps, while keeping 1 GB available
  // on low-memory computers. The cap avoids needlessly large heap allocations.
  return Math.max(1024, Math.min(16384, Math.floor((totalMemoryMb - 2048) / 512) * 512));
}

function getRecommendedMemoryAllocationMb(maximum = getMaximumMemoryAllocationMb()) {
  const totalMemoryMb = Math.floor(os.totalmem() / (1024 * 1024));
  const halfSystemMemory = Math.floor(totalMemoryMb / 2 / 512) * 512;
  return Math.max(1024, Math.min(maximum, 4096, halfSystemMemory));
}

function normalizeResolutionDimension(value, fallback, minimum, maximum) {
  const dimension = Number(value);
  return Number.isInteger(dimension) && dimension >= minimum && dimension <= maximum ? dimension : fallback;
}

function publicSettings(settings) {
  const normalized = normalizeSettings(settings);
  const publicProfiles = normalized.profiles.map(({ refreshTokenEncrypted, minecraftAccessTokenEncrypted, minecraftAccessTokenExpiresAt, ...profile }) => profile);
  const selectedProfile = publicProfiles.find(profile => profile.id === normalized.selectedProfileId) || publicProfiles[0];
  return { ...normalized, profiles: publicProfiles, profile: selectedProfile };
}

function patchSettings(current, patch) {
  const updated = { ...current, ...patch };
  if (patch.profile && current.selectedProfileId) {
    updated.profiles = current.profiles.map(profile => profile.id === current.selectedProfileId
      ? { ...profile, ...patch.profile, id: profile.id, type: profile.type }
      : profile);
  }
  return normalizeSettings(updated);
}

function encryptRefreshToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this device. Microsoft sign-in cannot be saved safely.');
  return safeStorage.encryptString(token).toString('base64');
}

function decryptRefreshToken(profile) {
  if (!profile.refreshTokenEncrypted || !safeStorage.isEncryptionAvailable()) {
    throw new Error('This Microsoft profile needs to be connected again.');
  }
  return safeStorage.decryptString(Buffer.from(profile.refreshTokenEncrypted, 'base64'));
}

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function plainText(value = '') {
  return decodeXml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function rawTag(block, tag) {
  const escaped = tag.replace(':', '\\:');
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function tagText(block, tag) {
  return plainText(rawTag(block, tag));
}

function attribute(block, tag, attr) {
  const escaped = tag.replace(':', '\\:');
  const re = new RegExp(`<${escaped}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["'][^>]*\\/?\\s*>`, 'i');
  const m = block.match(re);
  return m ? decodeXml(m[1].trim()) : '';
}

function normalizeImage(url) {
  if (!url) return '';
  const cleaned = decodeXml(url).trim();
  if (cleaned.startsWith('//')) return `https:${cleaned}`;
  if (/^https:\/\//i.test(cleaned)) return cleaned;
  return '';
}

function trustedNewsImage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['minecraft.net', 'mojang.com'].some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function parseMinecraftRss(xml, sourceLabel = 'Minecraft.net') {
  const items = [];
  const blocks = xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const block of blocks.slice(0, 20)) {
    const title = tagText(block, 'title');
    let link = tagText(block, 'link') || tagText(block, 'guid');
    if (!link) link = attribute(block, 'link', 'href');
    const rawDescription = rawTag(block, 'description') || rawTag(block, 'content:encoded') || rawTag(block, 'content') || rawTag(block, 'summary');
    const description = plainText(rawDescription);
    const pubDate = tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'dc:date');
    let image = normalizeImage(
      attribute(block, 'media:content', 'url') ||
      attribute(block, 'media:thumbnail', 'url') ||
      attribute(block, 'enclosure', 'url') ||
      attribute(block, 'image', 'url')
    );
    if (!image) {
      const imageMatch = decodeXml(rawDescription).match(/<img\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/i);
      if (imageMatch) image = normalizeImage(imageMatch[1]);
    }
    // Do not allow arbitrary external URLs into the article-opening window.
    if (!link) link = attribute(block, 'a10:link', 'href');
    let officialLink = false;
    try {
      const parsedLink = new URL(link);
      officialLink = parsedLink.protocol === 'https:' && ['minecraft.net', 'www.minecraft.net'].includes(parsedLink.hostname);
    } catch {}
    if (title && officialLink) {
      items.push({ title, link, description, pubDate, image, source: sourceLabel });
    }
  }
  return items;
}

async function requestText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    const xmlEncoding = bytes.subarray(0, 160).toString('ascii').match(/encoding\s*=\s*["']([^"']+)/i)?.[1];
    const declaredEncoding = contentType.match(/charset\s*=\s*["']?([^;"']+)/i)?.[1]?.trim();
    const encoding = (declaredEncoding || xmlEncoding || 'utf-8').toLowerCase();
    const body = new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '').trim();
    if (!/<(?:rss|feed|rdf:RDF)\b/i.test(body.slice(0, 2000))) {
      const hint = /<(?:!doctype\s+html|html)\b/i.test(body.slice(0, 500)) ? 'The server returned an HTML page instead of a feed (possibly a bot/challenge page).' : 'The server did not return an RSS/XML feed.';
      throw new Error(hint);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchArticleImage(articleUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok || !trustedNewsImage(response.url)) return '';
    const html = await response.text();
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const key = attribute(tag, 'meta', 'property') || attribute(tag, 'meta', 'name');
      if (!/^og:image$/i.test(key)) continue;
      const image = normalizeImage(attribute(tag, 'meta', 'content'));
      if (image && trustedNewsImage(image)) return image;
    }
  } catch {
    // An article still displays normally with its per-card fallback if image metadata is unavailable.
  } finally {
    clearTimeout(timeout);
  }
  return '';
}

async function addArticleImages(items) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (!item.image) item.image = await fetchArticleImage(item.link);
    }
  });
  await Promise.all(workers);
}

async function fetchMinecraftNews(forceRefresh = false) {
  if (!forceRefresh && cachedMinecraftNews && Date.now() - cachedMinecraftNewsAt < NEWS_CACHE_MS) {
    return cachedMinecraftNews;
  }
  if (minecraftNewsRequest) return minecraftNewsRequest;

  minecraftNewsRequest = (async () => {
    for (const feed of MINECRAFT_RSS_FEEDS) {
      try {
        const xml = await requestText(feed.url);
        const items = parseMinecraftRss(xml, feed.source);
        if (items.length) {
          await addArticleImages(items.slice(0, 6));
          cachedMinecraftNews = items;
          cachedMinecraftNewsAt = Date.now();
          return items;
        }
      } catch {
        // Return cached content if present; otherwise the renderer shows its retry state.
      }
    }
    // Keep the home screen usable during a temporary outage and avoid repeated console errors.
    return cachedMinecraftNews || [];
  })();
  try {
    return await minecraftNewsRequest;
  } finally {
    minecraftNewsRequest = null;
  }
}

async function fetchJsonResponse(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(url, options = {}) {
  const { response, body } = await fetchJsonResponse(url, options);
  if (!response.ok) {
    const detail = body.error_description || body.errorMessage || body.Message || body.error || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return body;
}

const MINECRAFT_LAUNCHER_CLIENT_ID = '00000000402b5328';
const MINECRAFT_LAUNCHER_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const pendingMicrosoftLogins = new Map();

async function exchangeMicrosoftForMinecraft(msaAccessToken, legacy = false) {
  const xbox = await requestJson('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: legacy ? msaAccessToken : `d=${msaAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  });
  const { response: xstsResponse, body: xsts } = await fetchJsonResponse('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' })
  });
  if (!xstsResponse.ok) {
    if (xsts.XErr === 2148916233) throw new Error('This Microsoft account does not have an Xbox profile yet. Create one, then try again.');
    if (xsts.XErr === 2148916238) throw new Error('This child Microsoft account needs an adult account to finish Xbox setup.');
    throw new Error(xsts.Message || `Xbox sign-in failed (HTTP ${xstsResponse.status}).`);
  }
  const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (!userHash || !xsts.Token) throw new Error('Xbox sign-in returned an incomplete response.');
  const { response: minecraftResponse, body: minecraft } = await fetchJsonResponse('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xsts.Token}` })
  });
  if (!minecraftResponse.ok) {
    const detail = String(minecraft.errorMessage || minecraft.error || minecraft.Message || '');
    if (minecraftResponse.status === 403 && /invalid app registration/i.test(detail)) {
      throw new Error('Microsoft sign-in worked, but Minecraft Services rejected this app registration. Eclipse needs its own Microsoft public Client ID approved for Minecraft Services.');
    }
    throw new Error(detail || `Minecraft sign-in failed (HTTP ${minecraftResponse.status}).`);
  }
  const { response: profileResponse, body: profile } = await fetchJsonResponse('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${minecraft.access_token}`, Accept: 'application/json' }
  });
  if (profileResponse.status === 404) throw new Error('This Microsoft account has no Minecraft: Java Edition profile.');
  if (!profileResponse.ok) throw new Error(profile.errorMessage || `Could not load the Minecraft profile (HTTP ${profileResponse.status}).`);
  if (!profile.id || !profile.name || !minecraft.access_token) throw new Error('Minecraft returned an incomplete profile.');
  const xuid = xsts.DisplayClaims?.xui?.[0]?.xid || xbox.DisplayClaims?.xui?.[0]?.xid || '';
  const expiresInSeconds = Number(minecraft.expires_in);
  return {
    accessToken: minecraft.access_token,
    expiresAt: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? Date.now() + expiresInSeconds * 1000 : 0,
    uuid: profile.id,
    name: profile.name,
    xuid
  };
}

async function beginMicrosoftAuthorization() {
  const state = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  for (const [key, pending] of pendingMicrosoftLogins) {
    if (pending.expiresAt <= now) pendingMicrosoftLogins.delete(key);
  }
  pendingMicrosoftLogins.set(state, { expiresAt: now + 5 * 60 * 1000 });
  const authorize = new URL('https://login.live.com/oauth20_authorize.srf');
  authorize.search = new URLSearchParams({
    client_id: MINECRAFT_LAUNCHER_CLIENT_ID,
    response_type: 'code',
    redirect_uri: MINECRAFT_LAUNCHER_REDIRECT_URI,
    scope: 'service::user.auth.xboxlive.com::MBI_SSL',
    display: 'touch',
    locale: 'en',
    state
  }).toString();
  try {
    await shell.openExternal(authorize.href);
  } catch (error) {
    pendingMicrosoftLogins.delete(state);
    throw error;
  }
  return true;
}

async function addMicrosoftProfile(callbackUrl) {
  const settings = readSettings();
  let callback;
  try {
    callback = new URL(String(callbackUrl || '').trim());
  } catch {
    throw new Error('Paste the full Microsoft redirect URL from your browser address bar.');
  }
  if (callback.protocol !== 'https:' || callback.hostname !== 'login.live.com' || callback.pathname !== '/oauth20_desktop.srf') {
    throw new Error('That URL is not the expected Microsoft sign-in redirect. Copy the full address bar URL after sign-in.');
  }
  const state = callback.searchParams.get('state');
  const pending = state ? pendingMicrosoftLogins.get(state) : null;
  if (!pending || pending.expiresAt <= Date.now()) {
    if (state) pendingMicrosoftLogins.delete(state);
    throw new Error('This sign-in has expired or could not be verified. Start Microsoft sign-in again.');
  }
  pendingMicrosoftLogins.delete(state);
  if (callback.searchParams.has('error')) throw new Error(callback.searchParams.get('error_description') || 'Microsoft sign-in was cancelled.');
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Microsoft did not return an authorization code. Copy the full redirect URL and try again.');
  const token = await requestJson('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: MINECRAFT_LAUNCHER_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: MINECRAFT_LAUNCHER_REDIRECT_URI,
      scope: 'service::user.auth.xboxlive.com::MBI_SSL'
    })
  });
  if (!token.access_token || !token.refresh_token) throw new Error('Microsoft sign-in did not return a renewable session. Please try again.');
  const minecraft = await exchangeMicrosoftForMinecraft(token.access_token, true);
  const profile = {
    id: crypto.randomUUID(),
    type: 'microsoft',
    mode: 'microsoft',
    name: minecraft.name,
    uuid: minecraft.uuid,
    xuid: minecraft.xuid,
    status: 'online',
    authFlow: 'legacy-minecraft-launcher',
    clientId: MINECRAFT_LAUNCHER_CLIENT_ID,
    refreshTokenEncrypted: encryptRefreshToken(token.refresh_token),
    minecraftAccessTokenEncrypted: encryptRefreshToken(minecraft.accessToken),
    minecraftAccessTokenExpiresAt: minecraft.expiresAt
  };
  settings.profiles.push(profile);
  settings.selectedProfileId = profile.id;
  writeSettings(settings);
  return publicSettings(settings);
}

async function refreshMicrosoftSession(profile, settings) {
  const legacy = profile.authFlow === 'legacy-minecraft-launcher';
  const clientId = profile.clientId || settings.microsoftClientId;
  if (!clientId) throw new Error('This Microsoft profile needs to be reconnected before it can launch.');
  // Minecraft access tokens carry their own expiry. Reusing a securely stored
  // token avoids five sequential auth/profile requests on every launcher start.
  if (profile.minecraftAccessTokenEncrypted && Number(profile.minecraftAccessTokenExpiresAt) > Date.now() + 5 * 60 * 1000) {
    try {
      const accessToken = decryptRefreshToken({ refreshTokenEncrypted: profile.minecraftAccessTokenEncrypted });
      if (accessToken && profile.uuid && profile.name) {
        return { accessToken, uuid: profile.uuid, name: profile.name, xuid: profile.xuid || '' };
      }
    } catch {
      // A cache that cannot be decrypted is discarded by replacing it on refresh.
    }
  }
  const token = await requestJson(legacy ? 'https://login.live.com/oauth20_token.srf' : 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: decryptRefreshToken(profile),
      ...(legacy ? {} : { scope: 'XboxLive.signin offline_access' })
    })
  });
  const session = await exchangeMicrosoftForMinecraft(token.access_token, legacy);
  if (profile.uuid && profile.uuid !== session.uuid) throw new Error('The signed-in Minecraft profile does not match this saved account. Reconnect the profile.');
  const current = readSettings();
  current.profiles = current.profiles.map(saved => saved.id === profile.id
    ? {
        ...saved,
        ...(token.refresh_token ? { refreshTokenEncrypted: encryptRefreshToken(token.refresh_token) } : {}),
        minecraftAccessTokenEncrypted: encryptRefreshToken(session.accessToken),
        minecraftAccessTokenExpiresAt: session.expiresAt,
        name: session.name,
        uuid: session.uuid,
        xuid: session.xuid
      }
    : saved);
  writeSettings(current);
  return session;
}

function secureSkinImageUrl(value) {
  try {
    const imageUrl = new URL(value);
    if (imageUrl.protocol === 'http:' && ['ely.by', 'textures.minecraft.net'].some(domain => imageUrl.hostname === domain || imageUrl.hostname.endsWith(`.${domain}`))) {
      imageUrl.protocol = 'https:';
    }
    const allowedHost = ['ely.by', 'textures.minecraft.net'].some(domain => imageUrl.hostname === domain || imageUrl.hostname.endsWith(`.${domain}`));
    return imageUrl.protocol === 'https:' && allowedHost ? imageUrl.href : '';
  } catch { return ''; }
}

async function skinJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': LAUNCHER_USER_AGENT } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

async function resolveSkinUrl(name) {
  const nickname = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(nickname)) return '';
  const cacheKey = nickname.toLowerCase();
  const cached = skinUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const cacheSkin = url => skinUrlCache.set(cacheKey, { url, expiresAt: Date.now() + SKIN_URL_CACHE_MS });

  const elyTextures = await skinJson(`https://skinsystem.ely.by/textures/${encodeURIComponent(nickname)}`);
  const elySkin = secureSkinImageUrl(elyTextures?.SKIN?.url);
  if (elySkin) {
    cacheSkin(elySkin);
    return elySkin;
  }

  // Ely.by proxies premium skins too, but fall back to Mojang's public profile API if Ely.by is unavailable.
  const officialProfile = await skinJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nickname)}`);
  if (officialProfile?.id) {
    const signedProfile = await skinJson(`https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(officialProfile.id)}`);
    const texturesProperty = signedProfile?.properties?.find(property => property.name === 'textures');
    if (texturesProperty?.value) {
      try {
        const textureData = JSON.parse(Buffer.from(texturesProperty.value, 'base64').toString('utf8'));
        const officialSkin = secureSkinImageUrl(textureData.textures?.SKIN?.url);
        if (officialSkin) {
          cacheSkin(officialSkin);
          return officialSkin;
        }
      } catch {}
    }
  }
  cacheSkin('');
  return '';
}

async function downloadProfileSkin(profileId) {
  const profile = readSettings().profiles.find(item => item.id === profileId);
  if (!profile) throw new Error('That profile could not be found.');
  const skinUrl = await resolveSkinUrl(profile.name);
  if (!skinUrl) throw new Error(`No Minecraft skin was found for ${profile.name}.`);

  const result = await dialog.showSaveDialog({
    title: `Download ${profile.name}'s Minecraft skin`,
    defaultPath: `${profile.name}.png`,
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
  const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png', 'User-Agent': LAUNCHER_USER_AGENT } });
    if (!response.ok || !/^image\/png\b/i.test(response.headers.get('content-type') || '')) throw new Error('Ely.by could not provide this skin image.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('The downloaded skin was not a valid PNG image.');
    fs.writeFileSync(result.filePath, bytes);
    return result.filePath;
  } finally { clearTimeout(timeout); }
}

function createNewsWindow(parent, url) {
  const newsWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    parent,
    modal: false,
    backgroundColor: '#070b16',
    title: 'Eclipse — Minecraft News',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  newsWindow.loadURL(url, { extraHeaders: 'Accept-Language: en-US,en;q=0.9\n' });
  return newsWindow;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#070b16',
    frame: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(sourceDirectory, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.on('console-message', details => {
    const level = String(details?.level || '').toLowerCase();
    const message = details?.message;
    const line = details?.lineNumber;
    const source = details?.sourceId;
    if (level === 'error' || level === 'warning') appendLauncherLog(`Renderer ${level}`, `${String(message || '').slice(0, 12000)}${source ? ` (${source}:${line || 0})` : ''}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    appendLauncherLog('Renderer process', `Renderer exited: ${details.reason || 'unknown reason'}${details.exitCode == null ? '' : ` (exit ${details.exitCode})`}.`);
  });
  win.webContents.on('unresponsive', () => appendLauncherLog('Renderer process', 'The launcher window became unresponsive.'));
  const reportWindowActivity = () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('window:activity', win.isFocused() && !win.isMinimized() && win.isVisible());
    }
  };
  win.on('focus', reportWindowActivity);
  win.on('blur', reportWindowActivity);
  win.on('minimize', reportWindowActivity);
  win.on('restore', reportWindowActivity);
  win.once('ready-to-show', async () => {
    // Apply saved appearance values before the first visible frame so the
    // default accent and blur settings never flash during startup.
    const appearance = publicSettings(readSettings());
    const initialAppearance = {
      accentColor: appearance.performanceMode ? '#963cff' : appearance.accentColor,
      glassStrength: appearance.glassStrength,
      backgroundBlur: appearance.performanceMode ? 0 : appearance.backgroundBlur,
      performanceMode: appearance.performanceMode
    };
    try {
      await win.webContents.executeJavaScript(`(() => {
        const appearance = ${JSON.stringify(initialAppearance)};
        const surfaceAlpha = (1 - appearance.glassStrength / 100 * 0.82).toFixed(2);
        document.body.style.setProperty('--eclipse-accent', appearance.accentColor);
        document.body.style.setProperty('--glass-alpha', surfaceAlpha);
        document.body.style.setProperty('--glass-blur', appearance.backgroundBlur + 'px');
        document.body.classList.toggle('performance-mode', appearance.performanceMode);
      })()`);
    } catch (error) {
      appendLauncherLog('Appearance', `Could not apply saved appearance before showing the window: ${error.message}`);
    }
    if (win.isDestroyed()) return;
    win.maximize();
    win.show();
    reportWindowActivity();
  });
  win.loadFile(path.join(sourceDirectory, 'index.html'));
}

function sendUpdateNotice(version) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('updates:available', version);
    }
  }
}
function sendUpdateReady(version) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('updates:ready', version);
  }
}

function initializeAutoUpdates() {
  // electron-updater supports this launcher's packaged Windows NSIS target.
  // Development runs and other platforms should never contact the release feed.
  if (!app.isPackaged || process.platform !== 'win32') return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.on('checking-for-update', () => appendLauncherLog('Updater', 'Checking the GitHub release feed.'));
  autoUpdater.on('update-available', info => {
    lastUpdateProgressLog = -10;
    appendLauncherLog('Updater', `Found Eclipse ${info.version}; downloading the update.`);
    sendUpdateNotice(info.version);
    autoUpdater.downloadUpdate().catch(error => {
      appendLauncherLog('Updater error', `Could not download the full update package: ${error?.stack || error?.message || error}`);
    });
  });
  autoUpdater.on('update-not-available', info => {
    appendLauncherLog('Updater', `Eclipse ${info.version || LAUNCHER_VERSION} is up to date.`);
  });
  autoUpdater.on('download-progress', progress => {
    const percent = Math.floor((progress.percent || 0) / 10) * 10;
    if (percent >= lastUpdateProgressLog + 10) {
      lastUpdateProgressLog = percent;
      appendLauncherLog('Updater', `Downloading update: ${percent}%.`);
    }
  });
  autoUpdater.on('update-downloaded', async info => {
    downloadedUpdateVersion = info.version;
    appendLauncherLog('Updater', `Eclipse ${info.version} has been downloaded and is ready to install.`);
    sendUpdateNotice(info.version);
    sendUpdateReady(info.version);
  });
  autoUpdater.on('error', error => {
    appendLauncherLog('Updater error', error?.stack || error?.message || error);
  });

  // Give the launcher window time to appear before showing the in-app notice.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(error => {
      appendLauncherLog('Updater error', `Update check failed: ${error?.stack || error?.message || error}`);
    });
  }, 2500);
}

app.whenReady().then(() => {
  ensureDirs();
  appendLauncherLog('Launcher', `Eclipse ${app.getVersion()} started.`);

  ipcMain.handle('diagnostics:list', () => listDiagnosticLogs());
  ipcMain.handle('diagnostics:read', (_, id) => readDiagnosticLog(id));
  ipcMain.handle('diagnostics:delete-crash-report', (_, id) => deleteDiagnosticCrashReport(id));
  ipcMain.handle('app:version', () => LAUNCHER_VERSION);
  ipcMain.handle('updates:pending-changelog', async () => {
    const pendingFile = path.join(app.getPath('userData'), 'pending-update-changelog.json');
    let pending;
    try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); }
    catch { return null; }
    if (pending.version !== LAUNCHER_VERSION) return null;
    try {
      const response = await fetch('https://api.github.com/repos/eclipse-launcher/eclipse-launcher.github.io/releases?per_page=100', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': LAUNCHER_USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' }
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
      const releases = await response.json();
      const release = releases.find(item => !item.draft && !item.prerelease && item.assets?.some(asset => /\.exe$/i.test(asset.name)));
      if (!release) throw new Error('No published launcher release with a Windows installer was found.');
      fs.rmSync(pendingFile, { force: true });
      return { version: release.tag_name || release.name || LAUNCHER_VERSION, body: String(release.body || '').slice(0, 20000) };
    } catch (error) {
      appendLauncherLog('Updater changelog', error?.stack || error?.message || error);
      fs.rmSync(pendingFile, { force: true });
      return { version: LAUNCHER_VERSION, body: '', unavailable: true };
    }
  });
  ipcMain.handle('updates:install', async () => {
    const helperPath = app.isPackaged
      ? path.join(process.resourcesPath, 'EclipseUpdateScreen.exe')
      : path.join(appRoot, 'build', 'EclipseUpdateScreen.exe');
    const imagePath = app.isPackaged
      ? path.join(process.resourcesPath, 'eclipse-updating-screen.jpg')
      : path.join(assetsDirectory, 'eclipse-updating-screen.jpg');
    const helperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-update-screen-'));
    const temporaryHelperPath = path.join(helperDirectory, 'EclipseUpdateScreen.exe');
    const temporaryImagePath = path.join(helperDirectory, 'eclipse-updating-screen.jpg');
    const readyFile = path.join(helperDirectory, 'screen.ready');
    const helperLog = path.join(app.getPath('userData'), 'logs', 'update-progress.log');
    if (!fs.existsSync(helperPath) || !fs.existsSync(imagePath)) {
      throw new Error('The Eclipse update screen files are missing from this installation.');
    }
    fs.copyFileSync(helperPath, temporaryHelperPath);
    fs.copyFileSync(imagePath, temporaryImagePath);
    fs.rmSync(readyFile, { force: true });
    const helper = spawn(temporaryHelperPath, [
      '--parent-pid', String(process.pid), '--image', temporaryImagePath,
      '--ready', readyFile, '--log', helperLog
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    appendLauncherLog('Updater', `Starting the update screen helper (PID ${process.pid}).`);
    await new Promise((resolve, reject) => { helper.once('spawn', resolve); helper.once('error', reject); });
    helper.unref();
    const readyDeadline = Date.now() + 20000;
    while (!fs.existsSync(readyFile) && Date.now() < readyDeadline) {
      if (helper.exitCode !== null) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!fs.existsSync(readyFile)) throw new Error(`The update screen exited with code ${helper.exitCode} before showing. See ${helperLog}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!fs.existsSync(readyFile)) throw new Error(`The update screen did not become ready. See ${helperLog}`);
    if (!downloadedUpdateVersion) throw new Error('The downloaded update version is unavailable.');
    fs.writeFileSync(path.join(app.getPath('userData'), 'pending-update-changelog.json'), JSON.stringify({ version: downloadedUpdateVersion }), 'utf8');
    autoUpdater.quitAndInstall(true, true);
  });
  ipcMain.handle('community:open', async (_, destination) => {
    const urls = {
      discord: 'https://discord.gg/8rrsEwcbQs',
      website: 'https://eclipse-launcher.github.io/'
    };
    const url = urls[destination];
    if (!url) throw new Error('That Eclipse community link is not available.');
    await shell.openExternal(url);
  });
  ipcMain.on('diagnostics:renderer-error', (_event, report) => {
    if (!report || typeof report !== 'object') return;
    const kind = String(report.kind || 'error').slice(0, 40);
    const message = String(report.message || 'Unknown renderer error').slice(0, 8000);
    const detail = String(report.detail || '').slice(0, 12000);
    appendLauncherLog(`Renderer ${kind}`, `${message}${detail ? `\n${detail}` : ''}`);
  });

  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender).minimize());
  ipcMain.handle('window:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    w.isMaximized() ? w.unmaximize() : w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender).close());

  ipcMain.handle('settings:get', () => {
    const settings = readSettings();
    return { ...publicSettings(settings), backgroundUrl: settings.background ? pathToFileURL(settings.background).href : null };
  });

  ipcMain.handle('settings:set', (_, patch) => {
    const current = readSettings();
    const settings = patchSettings(current, patch);
    writeSettings(settings);
    return { ...publicSettings(settings), backgroundUrl: settings.background ? pathToFileURL(settings.background).href : null };
  });

  ipcMain.handle('profile:add-offline', (_, name) => {
    const cleanName = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(cleanName)) throw new Error('Offline names must be 1–16 characters using letters, numbers, or underscores.');
    const settings = readSettings();
    const profile = { id: crypto.randomUUID(), type: 'offline', mode: 'offline', name: cleanName, status: 'online', note: '' };
    settings.profiles.push(profile);
    settings.selectedProfileId = profile.id;
    writeSettings(settings);
    return publicSettings(settings);
  });

  ipcMain.handle('profile:select', (_, profileId) => {
    const settings = readSettings();
    if (!settings.profiles.some(profile => profile.id === profileId)) throw new Error('That profile could not be found.');
    settings.selectedProfileId = profileId;
    writeSettings(settings);
    return publicSettings(settings);
  });

  ipcMain.handle('profile:set-note', (_, profileId, note) => {
    const cleanNote = String(note ?? '');
    if (cleanNote.length > 30000) throw new Error('This formatted note is too large to save. Please shorten it.');
    const settings = readSettings();
    const profile = settings.profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('That profile could not be found.');
    profile.note = cleanNote;
    profile.noteFormat = 'html-v1';
    writeSettings(settings);
    return true;
  });

  ipcMain.handle('profile:skin-url', async (_, profileId) => {
    const profile = readSettings().profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('That profile could not be found.');
    return resolveSkinUrl(profile.name);
  });

  ipcMain.handle('profile:skin-data', async (_, profileId) => {
    const profile = readSettings().profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('That profile could not be found.');
    const skinUrl = await resolveSkinUrl(profile.name);
    if (!skinUrl) throw new Error(`No Minecraft skin was found for ${profile.name}.`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png', 'User-Agent': LAUNCHER_USER_AGENT } });
      if (!response.ok) throw new Error(`Skin image server returned HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('The skin image is empty or too large to preview.');
      if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('The skin server returned an invalid PNG image.');
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } finally {
      clearTimeout(timeout);
    }
  });

  ipcMain.handle('profile:download-skin', async (_, profileId) => downloadProfileSkin(profileId));

  ipcMain.handle('profile:remove', (_, profileId) => {
    const settings = readSettings();
    if (settings.profiles.length < 2) throw new Error('Keep at least one profile in Eclipse.');
    settings.profiles = settings.profiles.filter(profile => profile.id !== profileId);
    if (settings.selectedProfileId === profileId) settings.selectedProfileId = settings.profiles[0].id;
    writeSettings(settings);
    return publicSettings(settings);
  });

  ipcMain.handle('accounts:begin-microsoft-login', async () => beginMicrosoftAuthorization());
  ipcMain.handle('accounts:complete-microsoft-login', async (_, callbackUrl) => addMicrosoftProfile(callbackUrl));
  ipcMain.handle('accounts:open-registration', async () => {
    await shell.openExternal('https://entra.microsoft.com/');
    return true;
  });

  ipcMain.handle('background:choose', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','webp'] }]
    });
    if (result.canceled) return null;
    const settings = readSettings();
    settings.background = result.filePaths[0];
    writeSettings(settings);
    return { path: result.filePaths[0], url: pathToFileURL(result.filePaths[0]).href };
  });

  ipcMain.handle('instance:choose-modpack', async event => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const selection = await dialog.showOpenDialog(parent, {
      title: 'Choose a Minecraft modpack folder or ZIP',
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Minecraft modpacks', extensions: ['zip'] }]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return selection.filePaths[0];
  });
  ipcMain.handle('instance:import-modpack', (_, folder, mode, addEclipseTheme) => importModpackFolder(folder, mode, addEclipseTheme !== false));

  ipcMain.handle('instance:create', async (_, options = {}) => {
    ensureDirs();
    const name = typeof options.name === 'string' ? options.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 32) throw new Error('Enter an instance name between 1 and 32 characters long.');
    const group = typeof options.group === 'string' ? options.group.trim().replace(/\s+/g, ' ').slice(0, 32) : '';
    const version = typeof options.version === 'string' ? options.version.trim() : '';
    if (!version || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version) || version.length > 24) throw new Error('Choose a Minecraft Version');
    const loader = String(options.loader || '').toLowerCase();
    if (!['vanilla', 'fabric', 'forge'].includes(loader)) throw new Error('Choose Vanilla, Fabric, or Forge.');
    const icons = new Set(['', 'book-emoji.png', 'diamond-emoji.png', 'emerald-emoji.png', 'enderpearl-emoji.png', 'goldenapple-emoji.png', 'hackerhead-emoji.png', 'hardcore-emoji.png', 'heart-emoji.png', 'ironsword-emoji.png', 'picaxe-emoji.png']);
    const icon = typeof options.icon === 'string' && icons.has(options.icon) ? options.icon : null;
    if (icon === null) throw new Error('Choose one of the available instance icons.');
    const allowedPerformanceMods = new Set(PERFORMANCE_MODS.map(mod => mod.id));
    const requestedPerformanceMods = Array.isArray(options.performanceMods) ? [...new Set(options.performanceMods)] : [];
    if (loader !== 'fabric' && requestedPerformanceMods.length) throw new Error('Performance mods require Fabric.');
    if (requestedPerformanceMods.some(id => typeof id !== 'string' || !allowedPerformanceMods.has(id))) throw new Error('One of the selected performance mods is not supported.');
    const allowedUtilityMods = new Set(UTILITY_MODS.map(mod => mod.id));
    const requestedUtilityMods = Array.isArray(options.utilityMods) ? [...new Set(options.utilityMods)] : [];
    if (loader !== 'fabric' && requestedUtilityMods.length) throw new Error('Utility mods require Fabric.');
    if (requestedUtilityMods.some(id => typeof id !== 'string' || !allowedUtilityMods.has(id))) throw new Error('One of the selected utility mods is not supported.');
    const addOptiFine = loader === 'forge' && options.addOptiFine === true;
    let optifineForgeVersion = '';
    if (addOptiFine) {
      const release = await findOptiFineRelease(version);
      const requiredForgeBuild = release?.forgeRequirement.replace(/^Forge\s*/i, '').trim() || '';
      const forgeVersion = /^N\/A$/i.test(requiredForgeBuild)
        ? await getForgeBuildForMinecraft(version)
        : await getForgeBuildForMinecraft(version, requiredForgeBuild);
      if (!optiFineCanBeAddedToForge(release, forgeVersion)) throw new Error(`OptiFine cannot be added to the Forge build selected for Minecraft ${version}.`);
      optifineForgeVersion = forgeVersion;
    }
    const useTLSkins = options.useTLSkins === true;
    if (useTLSkins) {
      if (!['fabric', 'forge'].includes(loader)) throw new Error('TL Skin & Cape requires Fabric or Forge.');
      if (!(await findTLSkinModRelease(version, loader))) throw new Error(`TL Skin & Cape has no ${loader} file for Minecraft ${version}.`);
    }
    const folder = safeInstanceFolder(name);
    if (fs.existsSync(path.join(instancesDir, folder))) throw new Error('An instance with this name already exists. Choose another name.');
    const existingNames = fs.readdirSync(instancesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
      try { return JSON.parse(fs.readFileSync(path.join(instancesDir, entry.name, 'eclipse-instance.json'), 'utf8')).name || entry.name; } catch { return entry.name; }
    });
    if (existingNames.some(existing => String(existing).toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('An instance with this name already exists. Choose another name.');
    const instancePath = path.join(instancesDir, folder);
    fs.mkdirSync(instancePath, { recursive: false });
    const metadata = { name, group, version, loader: loader[0].toUpperCase() + loader.slice(1), icon, customInstance: true, createdBy: 'user', lastPlayed: 0, playtimeMs: 0, builtInMods: [], eclipseCustomization: true, eclipseCustomizationBuiltInMods: [], eclipseBuiltInResourcePacks: [], performanceMods: requestedPerformanceMods, utilityMods: requestedUtilityMods, addOptiFine, optifineForgeVersion, useTLSkins };
    fs.writeFileSync(path.join(instancePath, 'eclipse-instance.json'), JSON.stringify(metadata, null, 2));
    return { ...metadata, folder, installed: false };
  });

  ipcMain.handle('instances:list', () => {
    ensureDirs();
    const folders = fs.readdirSync(instancesDir, { withFileTypes: true })
      .filter(x => x.isDirectory())
      .map(x => {
        const p = path.join(instancesDir, x.name);
        const metaPath = path.join(p, 'eclipse-instance.json');
        let meta = { name: x.name, version: '1.20.1', loader: 'Fabric', lastPlayed: 0 };
        if (fs.existsSync(metaPath)) {
          try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch {}
        }
        const imagePath = meta.image ? path.join(p, meta.image) : null;
        return {
          ...meta,
          folder: x.name,
          official: Boolean(getInstanceRelease(x.name, meta) && (INSTANCE_RELEASES[x.name] || meta.eclipseReleaseKey)),
          installed: isInstanceInstalled(x.name, meta),
          image: imagePath && fs.existsSync(imagePath) ? imagePath : null
        };
      });
    return folders;
  });

  ipcMain.handle('instances:versions', async (_, loader = 'vanilla') => {
    const manifest = await getMinecraftVersionManifest();
    const releases = (manifest.versions || []).filter(version => version.type === 'release').map(version => version.id);
    const selectedLoader = String(loader || 'vanilla').toLowerCase();
    if (selectedLoader === 'vanilla') return releases;
    if (selectedLoader === 'fabric') {
      const fabricVersions = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
      const supported = new Set((fabricVersions || []).filter(item => item.stable).map(item => item.version));
      return releases.filter(version => supported.has(version));
    }
    if (selectedLoader === 'forge') {
      const response = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', { headers: { 'User-Agent': LAUNCHER_USER_AGENT } });
      if (!response.ok) throw new Error(`Forge version lookup failed with HTTP ${response.status}.`);
      const metadataXml = await response.text();
      const supported = new Set([...metadataXml.matchAll(/<version>([^<]+)<\/version>/g)]
        .map(match => match[1].match(/^(\d+\.\d+(?:\.\d+)?)-/))
        .filter(Boolean)
        .map(match => match[1]));
      return releases.filter(version => supported.has(version));
    }
    throw new Error('Choose Vanilla, Fabric, or Forge.');
  });

  ipcMain.handle('performance:options', async (_, version, loader) => getPerformanceModOptions(version, loader));
  ipcMain.handle('utility:options', async (_, version, loader) => getUtilityModOptions(version, loader));
  ipcMain.handle('eclipse-customization:options', async (_, version, loader) => getEclipseCustomizationOptions(version, loader));
  ipcMain.handle('tlskins:options', async (_, version, loader) => getTLSkinModOptions(version, loader));

  ipcMain.handle('mods:list', async (_, folder) => {
    let timeout;
    try {
      return await Promise.race([
        listInstanceMods(folder),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Reading this instance’s mods timed out. Try Refresh again.')), 15000); })
      ]);
    } finally { clearTimeout(timeout); }
  });
  ipcMain.handle('mods:open-folder', (_, folder, assetType) => openInstanceModsFolder(folder, assetType));
  ipcMain.handle('mods:assets-list', (_, folder, assetType) => listInstanceAssets(folder, assetType));
  ipcMain.handle('mods:assets-remove', (_, folder, fileName, assetType) => removeInstanceAsset(folder, fileName, assetType));
  ipcMain.handle('mods:assets-install', (event, folder, projectId, assetType) => installModrinthAsset(event, folder, projectId, assetType));
  ipcMain.handle('mods:set-enabled', (_, folder, fileName, enabled) => setInstanceModEnabled(folder, fileName, Boolean(enabled)));
  ipcMain.handle('mods:remove', (_, folder, fileName) => removeInstanceMod(folder, fileName));
  ipcMain.handle('mods:search', (_, folder, query, options) => searchModrinthMods(query, folder, options));
  ipcMain.handle('mods:install', (event, folder, projectId) => installModrinthProject(event, folder, projectId));

  ipcMain.handle('instance:install', async (event, folder) => installInstance(event, folder));

  ipcMain.handle('instance:rename', (_, folder, requestedName, requestedIcon, requestedGroup) => {
    if (typeof folder !== 'string' || !folder || path.basename(folder) !== folder) {
      throw new Error('That Minecraft instance could not be found.');
    }
    const name = typeof requestedName === 'string' ? requestedName.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new Error('Enter a name for this instance.');
    if (name.length > 32) throw new Error('Instance names must be 32 characters or fewer.');
    const group = typeof requestedGroup === 'string' ? requestedGroup.trim().replace(/\s+/g, ' ').slice(0, 32) : '';
    const iconOptions = new Set(['', 'book-emoji.png', 'diamond-emoji.png', 'emerald-emoji.png', 'enderpearl-emoji.png', 'goldenapple-emoji.png', 'hackerhead-emoji.png', 'hardcore-emoji.png', 'heart-emoji.png', 'ironsword-emoji.png', 'picaxe-emoji.png']);
    if (typeof requestedIcon !== 'string' || !iconOptions.has(requestedIcon)) throw new Error('Choose one of the available instance icons.');
    const instancePath = path.join(instancesDir, folder);
    let instanceStat;
    try { instanceStat = fs.lstatSync(instancePath); } catch {
      throw new Error('That Minecraft instance could not be found.');
    }
    if (!instanceStat.isDirectory() || instanceStat.isSymbolicLink()) throw new Error('That Minecraft instance folder is invalid.');
    if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
      throw new Error('Close Minecraft and wait for installation or launch to finish before renaming this instance.');
    }
    const metaPath = path.join(instancePath, 'eclipse-instance.json');
    let metadata;
    try {
      const profileStat = fs.lstatSync(metaPath);
      if (!profileStat.isFile() || profileStat.isSymbolicLink()) throw new Error();
      metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch { throw new Error('The instance profile file is missing or invalid.'); }
    if (INSTANCE_RELEASES[folder] || (typeof metadata.eclipseReleaseKey === 'string' && INSTANCE_RELEASES[metadata.eclipseReleaseKey])) {
      throw new Error('By Eclipse instances cannot be renamed.');
    }
    const existingFolders = fs.readdirSync(instancesDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== folder);
    for (const entry of existingFolders) {
      let otherName = entry.name;
      try { otherName = JSON.parse(fs.readFileSync(path.join(instancesDir, entry.name, 'eclipse-instance.json'), 'utf8')).name || entry.name; } catch {}
      if (String(otherName).toLocaleLowerCase() === name.toLocaleLowerCase()) throw new Error('An instance with this name already exists. Choose another name.');
    }
    const renamedFolder = safeInstanceFolder(name);
    const renamedPath = path.resolve(instancesDir, renamedFolder);
    if (path.dirname(renamedPath) !== path.resolve(instancesDir)) throw new Error('That instance name produces an invalid folder path.');
    if (renamedFolder !== folder && fs.existsSync(renamedPath)) throw new Error('An instance folder with this name already exists. Choose another name.');
    const nextMetadata = { ...metadata, name, icon: requestedIcon, group };
    if (INSTANCE_RELEASES[folder]) nextMetadata.eclipseReleaseKey = folder;
    const temporaryProfile = path.join(instancePath, `.eclipse-instance-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporaryProfile, JSON.stringify(nextMetadata, null, 2), { encoding: 'utf8', flag: 'wx' });
    const profileBackup = path.join(instancePath, `.eclipse-instance-${crypto.randomUUID()}.bak`);
    fs.renameSync(metaPath, profileBackup);
    try {
      fs.renameSync(temporaryProfile, metaPath);
      if (renamedFolder !== folder) fs.renameSync(instancePath, renamedPath);
      fs.rmSync(path.join(renamedPath, path.basename(profileBackup)), { force: true });
    } catch (error) {
      try {
        const currentDirectory = fs.existsSync(renamedPath) ? renamedPath : instancePath;
        const currentMeta = path.join(currentDirectory, 'eclipse-instance.json');
        if (fs.existsSync(profileBackup)) {
          fs.rmSync(currentMeta, { force: true });
          fs.renameSync(profileBackup, currentMeta);
        }
        fs.rmSync(temporaryProfile, { force: true });
      } catch {}
      throw error;
    }
    const settings = readSettings();
    settings.pinnedInstances = settings.pinnedInstances.map(item => item === folder ? renamedFolder : item);
    if (settings.modsInstanceFolder === folder) settings.modsInstanceFolder = renamedFolder;
    writeSettings(settings);
    if (fileVerificationCache) {
      const oldPrefix = `${path.resolve(instancePath)}${path.sep}`;
      const newPrefix = `${renamedPath}${path.sep}`;
      for (const [key, value] of [...fileVerificationCache.entries()]) {
        if (key.includes(oldPrefix)) {
          fileVerificationCache.delete(key);
          fileVerificationCache.set(key.replace(oldPrefix, newPrefix), value);
        }
      }
      saveFileVerificationCacheSoon();
    }
    return { folder: renamedFolder, previousFolder: folder, name, icon: requestedIcon };
  });

  ipcMain.handle('instance:delete-files', (_, folder) => {
    const { instancePath, metadata } = getInstanceMetadata(folder);
    if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
      throw new Error('Close Minecraft and wait for any installation to finish before deleting this instance.');
    }
    const metadataPath = path.join(instancePath, 'eclipse-instance.json');
    let metadataStat;
    try { metadataStat = fs.lstatSync(metadataPath); } catch { throw new Error('The instance profile file is missing, so Eclipse cannot safely remove this instance.'); }
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('The instance profile file is invalid, so Eclipse cannot safely remove this instance.');

    let removedEntries = 0;
    const customInstanceDeleted = metadata.customInstance === true;
    if (customInstanceDeleted) {
      fs.rmSync(instancePath, { recursive: true, force: false, maxRetries: 4, retryDelay: 100 });
      removedEntries = 1;
    } else {
      for (const entry of fs.readdirSync(instancePath, { withFileTypes: true })) {
        if (entry.name === 'eclipse-instance.json') continue;
        const childPath = path.resolve(instancePath, entry.name);
        if (path.dirname(childPath) !== instancePath) throw new Error('The instance contains an unsafe file path.');
        fs.rmSync(childPath, { recursive: true, force: false, maxRetries: 4, retryDelay: 100 });
        removedEntries++;
      }
    }

    const settings = readSettings();
    settings.pinnedInstances = settings.pinnedInstances.filter(pinnedFolder => pinnedFolder !== folder);
    writeSettings(settings);
    if (fileVerificationCache) {
      const prefix = `:${instancePath}${path.sep}`;
      for (const key of fileVerificationCache.keys()) if (key.includes(prefix)) fileVerificationCache.delete(key);
      saveFileVerificationCacheSoon();
    }
    return { ok: true, folder, removedEntries, customInstanceDeleted };
  });

  ipcMain.handle('instance:reset-playtime', (_, folder) => {
    const { instancePath } = getInstanceMetadata(folder);
    if (activeInstanceInstalls.has(folder) || activeModInstalls.has(folder) || activeInstanceLaunches.has(folder) || pendingInstanceLaunches.has(folder)) {
      throw new Error('Close Minecraft and wait for any installation or launch to finish before resetting playtime.');
    }
    const metadataPath = path.join(instancePath, 'eclipse-instance.json');
    let metadataStat;
    try { metadataStat = fs.lstatSync(metadataPath); } catch { throw new Error('The instance profile file could not be found.'); }
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('The instance profile file is invalid.');
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch { throw new Error('The instance profile file could not be read.'); }
    metadata.playtimeMs = 0;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    return { folder, playtimeMs: 0 };
  });

  ipcMain.handle('instance:launch', async (event, instance) => {
    const folder = instance?.folder;
    if (typeof folder !== 'string' || path.basename(folder) !== folder) throw new Error('That Minecraft instance could not be found.');
    const { metadata: profileMetadata } = getInstanceMetadata(folder);
    const release = getInstanceRelease(folder, profileMetadata);
    if (!release) throw new Error('That Minecraft instance could not be found.');
    if (activeInstanceLaunches.size || pendingInstanceLaunches.size) throw new Error('Minecraft is already starting or running from Eclipse. Close it before launching another instance.');
    if (activeModInstalls.has(folder)) throw new Error('Wait for this instance’s mod installation to finish before launching it.');
    const instanceDir = path.join(instancesDir, folder);
    appendLauncherLog('Launch', `Starting ${String(profileMetadata.name || folder)} (${String(profileMetadata.version || 'unknown')} ${String(profileMetadata.loader || 'unknown')}).`);
    const metadataPath = path.join(instanceDir, 'eclipse-instance.json');
    let metadata = profileMetadata;
    if (!isInstanceInstalled(folder, metadata)) throw new Error('This instance is not installed or is missing required files. Install it before launching.');
    pendingInstanceLaunches.add(folder);
    try {
    sendLaunchStatus(event, folder, { state: 'preparing' });
    const runtimeComponent = metadata.runtimeComponent || (release.version === '26.2' ? 'java-runtime-epsilon' : 'java-runtime-gamma');
    const runtimeVersion = metadata.runtimeVersion || (release.version === '26.2' ? '25.0.1' : '17.0.15');
    if (!hasSafeRuntimeMetadata(runtimeComponent, runtimeVersion)) throw new Error('This instance has invalid Java runtime metadata.');
    const javaPath = runtimeJavaPath(runtimeComponent, runtimeVersion);
    const javaProbePath = runtimeJavaProbePath(runtimeComponent, runtimeVersion);

    const launcher = new Client();
    // MCLC uses its javaPath both to probe `-version` and to spawn the game. javaw.exe
    // is ideal for the game window, but suppresses the version text MCLC's probe expects.
    // Probe its companion java.exe while keeping javaw.exe as the actual game process.
    configureLauncherHandler(launcher, javaProbePath, instanceDir, false, true);
    const settings = readSettings();
    const profile = settings.profile;
    const microsoftSession = profile.type === 'microsoft' ? await refreshMicrosoftSession(profile, settings) : null;
    const username = microsoftSession?.name || profile.name || 'Steve';

    const opts = {
      authorization: {
        access_token: microsoftSession?.accessToken || '0',
        client_token: '',
        uuid: microsoftSession?.uuid || offlinePlayerUuid(username),
        name: username,
        user_properties: '{}',
        meta: microsoftSession
          ? { type: 'msa', demo: false, xuid: microsoftSession.xuid, clientId: profile.clientId || settings.microsoftClientId }
          : { type: 'legacy', demo: false }
      },
      root: instanceDir,
      version: {
        number: release.version,
        type: metadata.versionType || 'release',
        ...(release.launchProfile ? { custom: release.launchProfile } : {})
      },
      javaPath,
      // MCLC defaults to two concurrent downloads. A higher pool helps when
      // a launch finds missing/corrupt files; fully installed launches are unaffected.
      overrides: { maxSockets: 12 },
      memory: { min: '1G', max: `${settings.memoryAllocationMb}M` },
      window: { fullscreen: settings.minecraftFullscreen, width: String(settings.minecraftResolutionWidth), height: String(settings.minecraftResolutionHeight) },
      customArgs: [
        ...(String(metadata.loader).toLowerCase() === 'forge' ? getForgeJvmArguments(instanceDir, release.launchProfile) : []),
        ...(process.platform === 'win32' && release.version === '26.3' && runtimeVersion === '25.0.1'
          ? ['-XX:-UseZGC', '-XX:+UseG1GC']
          : [])
      ],
      // Mojang has a reported access violation in Microsoft Java 25.0.1's
      // ZGC path on Windows with Minecraft 26.3. Force the supported G1
      // collector for this affected runtime/version until that upstream
      // JVM crash is fixed. The negative flag makes this safe if the game
      // version JSON also supplies UseZGC.
    };

    let lastLaunchError = null;
    let earlyExitCode = null;
    let earlyProcessOutput = '';
    let minecraftWindowOpened = false;
    let playtimeSession = null;
    let gameProcess = null;
    let gameProcessFinalized = false;
    let launcherWindowRestored = false;
    let launcherWindowRestoreScheduled = false;
    let launcherWindow = BrowserWindow.fromWebContents(event.sender);
    let launchWindowAction = settings.launchAction;
    let forgeLoadingWindowHidden = false;
    let loggedMinecraftErrors = 0;
    const reportLaunchProgress = createThrottledLaunchProgress(event, folder);
    const launchProgress = createLaunchProgressReporter(reportLaunchProgress);
    launchProgress.advance(5, true);
    const markMinecraftWindowOpened = () => {
      if (minecraftWindowOpened) return;
      minecraftWindowOpened = true;
      switch (launchWindowAction) {
        case 'close': launcherWindow?.close(); break;
        case 'hide': launcherWindow?.hide(); break;
        case 'nothing': break;
        case 'minimize':
        default: launcherWindow?.minimize(); break;
      }
      try {
        playtimeSession = startInstancePlaytime(folder, (playtimeMs, lastPlayed) => {
          sendLaunchStatus(event, folder, { state: 'playing', playtimeMs, lastPlayed });
        });
      } catch (error) {
        console.warn('[Minecraft] Could not start instance playtime tracking:', error.message);
      }
      sendLaunchStatus(event, folder, {
        state: 'playing',
        playtimeMs: playtimeSession?.initialPlaytimeMs,
        lastPlayed: playtimeSession?.startedAt
      });
    };
    const restoreLauncherWindow = () => {
      if (launcherWindowRestored || launcherWindowRestoreScheduled || !launcherWindow || launcherWindow.isDestroyed()) return;
      if (!['minimize', 'hide'].includes(launchWindowAction)) return;
      launcherWindowRestoreScheduled = true;
      setTimeout(() => {
        launcherWindowRestoreScheduled = false;
        if (launcherWindowRestored || !launcherWindow || launcherWindow.isDestroyed()) return;
        if (launchWindowAction === 'minimize') launcherWindow.maximize();
        else {
          launcherWindow.show();
          launcherWindow.focus();
        }
        launcherWindowRestored = true;
      }, 1000);
    };
    launcher.on('debug', msg => {
      const message = String(msg);
      if (message.includes('[MCLC]: Failed to start due to')) {
        lastLaunchError = message.replace(/^.*?Failed to start due to /, '').replace(/, closing\.\.\.$/, '');
        console.error('[Minecraft launcher]', lastLaunchError);
      }
    });
    launcher.on('data', msg => {
      const output = String(msg);
      earlyProcessOutput = `${earlyProcessOutput}${output}`.slice(-12000);
      if (!forgeLoadingWindowHidden && String(metadata.loader).toLowerCase() === 'forge' &&
          launchWindowAction === 'hide' && /Loading ImmediateWindowProvider fmlearlywindow/i.test(output) &&
          launcherWindow && !launcherWindow.isDestroyed()) {
        launcherWindow.hide();
        forgeLoadingWindowHidden = true;
      }
      const mods = output.match(/Loading (\d+) mods:/);
      if (mods) reportLaunchProgress({ phase: 'minecraft-startup', status: `Loading ${mods[1]} mods`, percent: null });
      if (/Loading \d+ mods:/.test(output)) launchProgress.advance(92, true);
      // Recent Minecraft releases log this after creating the game window and
      // completing client startup. The older 26.2-only check left newer releases
      // (such as 26.3) showing Eclipse's loading state after Minecraft was ready.
      // These messages are emitted as soon as SDL/GLFW creates Minecraft's window,
      // before resource and loading-screen work finishes. React here instead of
      // waiting for later startup-complete messages, without polling or delaying launch.
      if (/Created window using SDL video driver|Created:\s*\d+x\d+x/i.test(output)) markMinecraftWindowOpened();
      else if (/Game took [\d.]+ seconds to start|Sound engine started/.test(output)) markMinecraftWindowOpened();
      // Bring Eclipse back as soon as Minecraft starts its normal shutdown,
      // even if mod/native cleanup keeps the Java process alive for a while.
      if (/\[Render thread\/INFO\]:\s*Stopping!/.test(output)) restoreLauncherWindow();
      if (loggedMinecraftErrors < 12) {
        for (const line of output.split(/\r?\n/)) {
          if (/\/(?:ERROR|FATAL)\]|Exception in thread|\bFATAL\b/.test(line)) {
            console.error('[Minecraft]', line.slice(0, 500));
            if (++loggedMinecraftErrors >= 12) break;
          }
        }
      }
    });
    launcher.on('close', code => {
      earlyExitCode = code;
      if (code !== 0 && earlyProcessOutput.trim()) appendLauncherLog('Minecraft early-exit output', earlyProcessOutput.trim());
    });
    launcher.on('download-status', status => {
      launchProgress.report(status.type, status.current, status.total);
    });
    launcher.on('progress', progress => {
      launchProgress.report(progress.type, progress.task, progress.total);
    });
    launcher.on('arguments', launchArguments => {
      launchProgress.advance(86, true);
      const archivePath = getStartupArchivePath(instanceDir, javaPath, launchArguments, runtimeVersion, metadata.loader);
      if (!archivePath) return;
      let archiveReady = false;
      try {
        const archiveStat = fs.statSync(archivePath);
        archiveReady = archiveStat.isFile() && archiveStat.size > 0;
        if (!archiveReady) fs.rmSync(archivePath, { force: true });
      } catch {}
      const flag = archiveReady
        ? `-XX:SharedArchiveFile=${archivePath}`
        : `-XX:ArchiveClassesAtExit=${archivePath}`;
      const classpathIndex = launchArguments.findIndex(argument => argument === '-cp' || argument === '-classpath' || argument === '--class-path');
      if (classpathIndex >= 0) {
        launchArguments.splice(classpathIndex, 0, flag);
        appendLauncherLog('Launch', archiveReady
          ? `Using the saved Java class archive for ${folder}.`
          : `Recording Java classes for a faster future launch of ${folder}.`);
      }
    });

    try {
      gameProcess = await launcher.launch(opts);
      if (!gameProcess || !gameProcess.pid) {
        const detail = lastLaunchError || (earlyExitCode != null ? `Minecraft exited before opening (exit code ${formatProcessExitCode(earlyExitCode)}).` : 'The Minecraft process could not be started.');
        throw new Error(detail);
      }
      activeInstanceLaunches.set(folder, gameProcess);
      appendLauncherLog('Launch', `${String(metadata.name || folder)} started with PID ${gameProcess.pid}.`);
      gameProcess.once('error', error => {
        if (activeInstanceLaunches.get(folder) !== gameProcess) return;
        gameProcessFinalized = true;
        activeInstanceLaunches.delete(folder);
        appendLauncherLog('Launch error', `[${folder}] Minecraft process error: ${error?.stack || error}`);
        const playtimeMs = playtimeSession?.stop();
        restoreLauncherWindow();
        sendLaunchStatus(event, folder, { state: 'failed', message: error.message, playtimeMs });
      });
      const finalizeGameProcess = (code, signal) => {
        if (gameProcessFinalized) return;
        gameProcessFinalized = true;
        if (activeInstanceLaunches.get(folder) !== gameProcess) return;
        activeInstanceLaunches.delete(folder);
        const playtimeMs = playtimeSession?.stop();
        appendLauncherLog('Launch', `${String(metadata.name || folder)} closed with ${code == null ? 'no exit code' : `exit code ${formatProcessExitCode(code)}`}${signal ? ` (${signal})` : ''}.`);
        restoreLauncherWindow();
        sendLaunchStatus(event, folder, { state: 'closed', code, signal, playtimeMs });
      };
      // Restore as soon as the Java process exits. 'close' waits for stdio to
      // finish closing too, which can lag behind the actual game window exit.
      gameProcess.once('exit', finalizeGameProcess);
      gameProcess.once('close', finalizeGameProcess);
      if (minecraftWindowOpened) {
        sendLaunchStatus(event, folder, {
          state: 'playing',
          playtimeMs: playtimeSession?.persistElapsed(),
          lastPlayed: playtimeSession?.startedAt
        });
      } else sendLaunchStatus(event, folder, { state: 'loading' });
      return { ok: true };
    } catch (error) {
      const playtimeMs = playtimeSession?.stop();
      appendLauncherLog('Launch error', `[${folder}] ${error?.stack || error?.message || error}`);
      sendLaunchStatus(event, folder, { state: 'failed', message: error.message, playtimeMs });
      throw error;
    }
    } finally {
      pendingInstanceLaunches.delete(folder);
    }
  });

  ipcMain.handle('news:list', async (_, options) => fetchMinecraftNews(Boolean(options?.refresh)));
  ipcMain.handle('news:open', async (event, url) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { throw new Error('This Minecraft article link is invalid.'); }
    if (parsedUrl.protocol !== 'https:' || !['minecraft.net', 'www.minecraft.net'].includes(parsedUrl.hostname)) throw new Error('Only official Minecraft.net articles can be opened.');
    const parent = BrowserWindow.fromWebContents(event.sender);
    createNewsWindow(parent, parsedUrl.href);
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  createWindow();
  initializeAutoUpdates();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
