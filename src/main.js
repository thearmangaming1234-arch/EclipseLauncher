const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const util = require('util');
const http = require('http');
const { Readable } = require('stream');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Client } = require('minecraft-launcher-core');
const extractZip = require('extract-zip');
const yauzl = require('yauzl');

const isDev = !app.isPackaged;
const appIconPath = path.join(__dirname, '..', 'assets', 'favicon.ico');
if (process.platform === 'win32') app.setAppUserModelId('com.eclipse.launcher');
// During development, read the instances folder sitting next to src/.
// In a packaged launcher, userData is used so the installed app can write to it.
const instancesDir = isDev
  ? path.join(__dirname, '..', 'instances')
  : path.join(app.getPath('userData'), 'instances');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_BACKGROUND_NAME = 'Neon Eclipse Over Voxel Lakescape.png';
const defaultBackgroundSource = path.join(app.getAppPath(), 'assets', DEFAULT_BACKGROUND_NAME);
const defaultBackgroundPath = path.join(app.getPath('userData'), 'backgrounds', DEFAULT_BACKGROUND_NAME);
const launcherLogFile = path.join(app.getPath('userData'), 'logs', 'eclipse-launcher.log');
const launcherLogBackupFile = `${launcherLogFile}.1`;
const LAUNCHER_LOG_MAX_BYTES = 8 * 1024 * 1024;
const DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;
const fileVerificationCacheFile = path.join(app.getPath('userData'), 'file-verification-cache.json');
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
    try { return fs.statSync(runtimeFile).isFile() && fs.statSync(runtimeFile).size === file.size; } catch { return false; }
  })) return false;
  const packReady = metadata.customInstance === true || (hasModJar(instancePath) && hasContentFile(config));
  const loader = String(metadata.loader || profile.loader || 'Fabric').toLowerCase();
  return fs.existsSync(marker) && fs.statSync(marker).isFile() && fs.existsSync(mods) && fs.statSync(mods).isDirectory() && packReady &&
    fs.existsSync(config) && fs.statSync(config).isDirectory() && fs.existsSync(java) && fs.existsSync(probeJava) &&
    (!profile.launchProfile || (launchProfile.id === profile.launchProfile && launchProfile.inheritsFrom === profile.version)) &&
    runtimeStamp.component === runtimeComponent && runtimeStamp.version === runtimeVersion &&
    ['fabric', 'vanilla', 'forge'].includes(loader) && String(metadata.version || profile.version) === profile.version &&
    (release ? loader === 'fabric' : metadata.customInstance === true);
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
  if (!event.sender.isDestroyed()) event.sender.send('instance:install-progress', { folder, ...progress });
}

function sendLaunchStatus(event, folder, status) {
  if (!event.sender.isDestroyed()) event.sender.send('instance:launch-status', { folder, ...status });
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

function configureLauncherHandler(launcher, javaProbePath, instanceRoot, strictDownloads = false) {
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
        handler.checkJava = () => checkJava(javaProbePath);
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
  const response = await fetch(url, { headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
  if (!response.ok) throw new Error(`Could not retrieve installation metadata (${response.status}): ${url}`);
  return response.json();
}

async function downloadFile(url, destination, onProgress) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
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
const MODRINTH_USER_AGENT = 'thearmangaming1234-arch/StarEclipseLauncher/0.10.30';
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
const TL_SKIN_ALLOWED_HOST = host => host === '9minecraft.net' || host.endsWith('.9minecraft.net') || host === 'cdn9mc.com' || host.endsWith('.cdn9mc.com');
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

function getInstanceModContext(folder, requireInstalled = true) {
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
  const installed = isInstanceInstalled(folder, metadata);
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
  const mods = await mapConcurrent(fileNames, 12, async fileName => {
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
  const context = getInstanceModContext(folder);
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
  return listInstanceMods(folder);
}

async function removeInstanceMod(folder, fileName) {
  assertModFolderIdle(folder);
  const context = getInstanceModContext(folder);
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName || !/\.jar(?:\.disabled)?$/i.test(fileName)) throw new Error('That mod file could not be found.');
  if (Array.isArray(context.metadata.eclipseCustomizationBuiltInMods) && context.metadata.eclipseCustomizationBuiltInMods.includes(baseJarName(fileName))) throw new Error('Eclipse customization mods cannot be removed.');
  const target = path.resolve(context.modsPath, fileName);
  if (path.dirname(target) !== path.resolve(context.modsPath)) throw new Error('That mod file path is invalid.');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That mod file is invalid.');
  const builtIns = ensureBuiltInModRecord(context);
  fs.unlinkSync(target);
  if (builtIns.has(baseJarName(fileName))) context.metadata.builtInMods = context.metadata.builtInMods.filter(name => name !== baseJarName(fileName));
  fs.writeFileSync(path.join(context.instancePath, 'eclipse-instance.json'), JSON.stringify(context.metadata, null, 2), 'utf8');
  const registry = readModrinthRegistry(context.modsPath);
  delete registry[baseJarName(fileName)];
  writeModrinthRegistry(context.modsPath, registry);
  return listInstanceMods(folder);
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
    const response = await fetch('https://optifine.net/downloads', { headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
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
    const response = await fetch(TL_SKIN_MOD_PAGE, { headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
    if (!response.ok) throw new Error(`TL Skin & Cape version lookup failed with HTTP ${response.status}.`);
    const pageUrl = new URL(response.url);
    if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== 'www.9minecraft.net') throw new Error('TL Skin & Cape redirected to an unexpected website.');
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
      const landingResponse = await fetch(downloadPageUrl, { redirect: 'follow', headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
      if (!landingResponse.ok) throw new Error(`The download page returned HTTP ${landingResponse.status}.`);
      const landingUrl = new URL(landingResponse.url);
      if (landingUrl.protocol !== 'https:' || !TL_SKIN_ALLOWED_HOST(landingUrl.hostname)) throw new Error('The site redirected to an unexpected download page.');
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
        headers: { 'User-Agent': 'EclipseLauncher/0.10.30', ...(downloadUrl._cookieHeader ? { Cookie: downloadUrl._cookieHeader } : {}), Accept: 'application/java-archive, application/octet-stream' }
      });
      if (!response.ok || !response.body) throw new Error(`The file request returned HTTP ${response.status}.`);
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || !TL_SKIN_ALLOWED_HOST(finalUrl.hostname)) throw new Error('The file redirected to an unexpected host.');
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
  const release = await findOptiFineRelease(version);
  const forgeVersion = `${version}-${forgeBuild || ''}`;
  if (!optiFineCanBeAddedToForge(release, forgeVersion)) throw new Error(`OptiFine cannot be added to the Forge build selected for Minecraft ${version}.`);
  const startUrl = new URL(`/adloadx?f=${encodeURIComponent(release.filename)}`, 'https://optifine.net');
  sendInstallProgress(event, folder, { phase: 'performance-mods', status: 'Preparing the official OptiFine download', percent: 92 });
  const landingResponse = await fetch(startUrl, { headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
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
  const response = await fetch(downloadUrl, { redirect: 'follow', headers: { 'User-Agent': 'EclipseLauncher/0.10.30', Accept: 'application/java-archive, application/octet-stream' } });
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
  const modsPath = path.join(instancePath, 'mods');
  fs.mkdirSync(modsPath, { recursive: true });
  const destination = path.join(modsPath, release.filename);
  if (fs.existsSync(destination)) throw new Error('OptiFine is already present in this instance.');
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

async function downloadModrinthAssetZip(file, destination, report) {
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
        report?.(received, Number(file.size) || contentLength || 0);
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
  const sendProgress = update => {
    if (!event.sender.isDestroyed()) event.sender.send('mods:install-progress', { folder, ...update });
  };
  try {
    sendProgress({ status: 'Checking asset compatibility', percent: 4 });
    const project = await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`);
    const expectedType = selectedType === 'resourcepack' ? 'resourcepack' : 'shader';
    if (project.project_type !== expectedType) throw new Error('That Modrinth project is not the selected asset type.');
    const registry = readModrinthAssetRegistry(assetDirectory);
    if (Object.values(registry).some(asset => asset?.projectId === projectId)) {
      sendProgress({ status: 'This asset is already installed', percent: 100, complete: true });
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
    sendProgress({ status: `Downloading ${project.title || (selectedType === 'resourcepack' ? 'resource pack' : 'shader pack')}`, percent: 8 });
    await downloadModrinthAssetZip(file, stagedFile, (received, total) => {
      const percent = total ? Math.min(92, Math.round(8 + received / total * 84)) : null;
      sendProgress({ status: `Downloading ${project.title || 'Modrinth asset'}`, percent });
    });
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
    sendProgress({ status: `${selectedType === 'resourcepack' ? 'Resource pack' : 'Shader pack'} installed`, percent: 100, complete: true });
    return { folder, assetType: selectedType, installedCount: 1, fileName: filename };
  } catch (error) {
    if (createdDestination) fs.rmSync(createdDestination, { force: true });
    sendProgress({ status: error.message || 'Asset installation failed', percent: null, error: true });
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
  const context = getInstanceModContext(folder, !duringInstanceInstall);
  const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-modrinth-'));
  activeModInstalls.add(folder);
  const createdModFiles = [];
  const sendProgress = update => {
    if (!event.sender.isDestroyed()) event.sender.send('mods:install-progress', { folder, ...update });
    if (duringInstanceInstall) sendInstallProgress(event, folder, {
      phase: 'performance-mods',
      status: update.status || 'Installing performance mods',
      percent: update.percent == null ? null : Math.round(92 + update.percent * 0.07)
    });
  };
  try {
    const current = context.installed || duringInstanceInstall ? await listInstanceMods(folder, true) : { mods: [] };
    // listInstanceMods returns inventory metadata as an object; its `mods`
    // member is the actual array. Calling map on the wrapper breaks every install.
    const currentMods = Array.isArray(current.mods) ? current.mods : [];
    const existingProjects = new Set(currentMods.map(mod => mod.modrinthProjectId).filter(Boolean));
    const existingModIds = new Set(currentMods.flatMap(mod => [mod.id, mod.name, mod.baseName]).map(normalizeModIdentity).filter(Boolean));
    const registry = readModrinthRegistry(context.modsPath);
    const projectCache = new Map();
    const getProject = async id => {
      if (!projectCache.has(id)) projectCache.set(id, await modrinthJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}`));
      return projectCache.get(id);
    };
    const isInstalled = async id => {
      if (existingProjects.has(id)) return true;
      const project = await getProject(id);
      return existingModIds.has(normalizeModIdentity(project.slug)) || existingModIds.has(normalizeModIdentity(project.title));
    };
    const visiting = new Set();
    const scheduled = new Set();
    const resolved = [];
    const visit = async (id, label, versionId = '') => {
      if (scheduled.has(id)) return;
      if (visiting.has(id)) return;
      visiting.add(id);
      const installedRecord = Object.values(registry).find(mod => mod?.projectId === id);
      const installed = await isInstalled(id);
      const version = await findCompatibleModrinthVersion(id, context, versionId || (installed ? installedRecord?.versionId || '' : ''));
      for (const dependency of version.dependencies || []) {
        if (dependency.dependency_type !== 'required') continue;
        const dependencyId = dependency.project_id || (dependency.version_id ? (await modrinthJson(`${MODRINTH_API}/version/${encodeURIComponent(dependency.version_id)}`)).project_id : '');
        if (!dependencyId) throw new Error(`${label} has a required external dependency that Eclipse cannot resolve automatically.`);
        const project = await getProject(dependencyId);
        const dependencyName = project.title || project.name || project.slug || 'Required dependency';
        try {
          await visit(dependencyId, dependencyName, dependency.version_id || '');
        } catch (error) {
          if (error.code === 'MODRINTH_INCOMPATIBLE') {
            const compatibilityError = new Error(`${label} requires ${dependencyName}, which does not support this ${context.metadata.loader} instance and Minecraft ${context.metadata.version || context.release.version}.`);
            compatibilityError.code = 'MODRINTH_INCOMPATIBLE';
            throw compatibilityError;
          }
          throw error;
        }
      }
      const project = await getProject(id);
      if (!installed) {
        const file = chooseModrinthJar(version);
        resolved.push({ projectId: id, slug: String(project.slug || ''), name: String(project.title || label), description: String(project.description || ''), icon: secureModrinthIcon(project.icon_url), versionId: version.id, version: version.version_number, file });
      }
      scheduled.add(id);
      visiting.delete(id);
    };
    sendProgress({ status: 'Checking compatible versions and dependencies', percent: 4 });
    for (const id of projectIds) {
      const project = await getProject(id);
      await visit(id, project.title || project.name || project.slug || 'Performance mod');
    }
    if (!resolved.length) {
      sendProgress({ status: 'The mod and its required dependencies are already installed', percent: 100, complete: true });
      return { ...(await listInstanceMods(folder, true)), installedCount: 0 };
    }

    const staged = [];
    for (let index = 0; index < resolved.length; index++) {
      const item = resolved[index];
      const filename = path.basename(item.file.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
      if (!filename.toLowerCase().endsWith('.jar')) throw new Error('Modrinth returned a file that is not a JAR.');
      const stagedPath = path.join(staging, `${index}.jar`);
      sendProgress({ status: `Downloading ${item.name}`, percent: Math.round(8 + 84 * index / resolved.length) });
      await downloadModrinthJar(item.file, stagedPath, (received, total) => {
        const downloadPart = total ? Math.round(84 * (index + received / total) / resolved.length) : 0;
        sendProgress({ status: `Downloading ${item.name}`, percent: Math.min(92, 8 + downloadPart) });
      });
      staged.push({ ...item, filename, stagedPath });
    }

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
      fs.copyFileSync(item.stagedPath, destination, fs.constants.COPYFILE_EXCL);
      createdModFiles.push(destination);
      registry[item.filename] = { projectId: item.projectId, slug: item.slug, name: item.name, description: item.description, icon: item.icon, modId: '', version: item.version, versionId: item.versionId };
    }
    writeModrinthRegistry(context.modsPath, registry);
    sendProgress({ status: `Installed ${resolved.length} mod${resolved.length === 1 ? '' : 's'} with required dependencies`, percent: 100, complete: true });
    return { ...(await listInstanceMods(folder, true)), installedCount: staged.length };
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
    if (installableProjects.length) await installModrinthProject(event, folder, installableProjects, true);
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
  const response = await fetch(source, { redirect: 'follow', headers: { 'User-Agent': 'EclipseLauncher/0.10.30', Accept: 'application/octet-stream' } });
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
      await installModrinthProject(event, folder, availableMods.map(mod => mod.id), true);
      const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'eclipse-customization-config-'));
      const archive = path.join(staging, 'config.zip');
      const extracted = path.join(staging, 'extracted');
      try {
        sendInstallProgress(event, folder, { phase: 'eclipse-customization', status: 'Downloading Eclipse menu and Discord configuration', percent: null });
        await downloadEclipseReleaseAsset(ECLIPSE_CONFIG_ZIP_URL, archive, 16 * 1024 * 1024, (received, total) => {
          sendInstallProgress(event, folder, { phase: 'eclipse-customization', status: 'Downloading Eclipse menu and Discord configuration', percent: total ? Math.min(99, Math.round(received / total * 100)) : null });
        });
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
  await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, worker));
  if (!fs.existsSync(javaPath)) throw new Error('Java runtime installation did not produce its launcher executable.');
  fs.writeFileSync(path.join(basePath, '.eclipse-runtime-ready.json'), JSON.stringify({
    component,
    version: manifestInfo.version.name,
    files: files.map(([relative, item]) => ({ path: relative, size: item.downloads.raw.size, sha1: item.downloads.raw.sha1 }))
  }, null, 2));
  return { javaPath, runtimeVersion: manifestInfo.version.name };
}

async function resolveMinecraftVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Enter a valid Minecraft version number.');
  const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const entry = manifest.versions?.find(item => item.id === version);
  if (!entry) throw new Error(`Minecraft ${version} is not in Mojang’s version manifest.`);
  const details = await fetchJson(entry.url);
  const majorVersion = Number(details.javaVersion?.majorVersion);
  if (!Number.isInteger(majorVersion)) throw new Error(`Mojang did not provide Java compatibility details for Minecraft ${version}.`);
  return { entry, details, majorVersion, runtimeComponent: javaRuntimeComponent(majorVersion) };
}

async function getForgeBuildForMinecraft(version, requiredBuild = '') {
  const response = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', { headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
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
    const runtime = await installJavaRuntime(runtimeComponent, update => sendInstallProgress(event, folder, update));
    for (const directory of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'versions']) fs.mkdirSync(path.join(instancePath, directory), { recursive: true });
    const loaderInfo = await prepareCustomLoader(instancePath, metadata.version, String(metadata.loader || 'Vanilla').toLowerCase(), Object.assign(
      update => sendInstallProgress(event, folder, update),
      { runtimeJavaPath: runtime.javaPath, runtimeComponent, runtimeVersion: runtime.runtimeVersion, preferredForgeVersion: metadata.addOptiFine ? metadata.optifineForgeVersion : '' }
    ));
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
    await downloadMinecraftDependencies(event, folder, instancePath, updated);
    await installPerformanceMods(event, folder, instancePath, updated);
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
    const fabricProfile = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(release.version)}/${encodeURIComponent(release.fabricLoader)}/profile/json`);
    if (fabricProfile.id !== release.launchProfile || fabricProfile.inheritsFrom !== release.version || !Array.isArray(fabricProfile.libraries)) {
      throw new Error('Fabric returned an unexpected launch profile.');
    }
    const profileDir = path.join(extracted, 'versions', release.launchProfile);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, `${release.launchProfile}.json`), JSON.stringify(fabricProfile, null, 2), 'utf8');

    sendInstallProgress(event, folder, { phase: 'runtime', status: 'Setting up the required Java runtime', percent: 0 });
    const runtimeComponent = release.version === '26.2' ? 'java-runtime-epsilon' : 'java-runtime-gamma';
    const runtime = await installJavaRuntime(runtimeComponent, update => sendInstallProgress(event, folder, update));

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
    await downloadMinecraftDependencies(event, folder, instancePath, installedMetadata);
    await ensureEclipseEssentialsPack(event, folder, instancePath, installedMetadata);
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
    activeInstanceInstalls.delete(folder);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
function ensureDirs() {
  fs.mkdirSync(instancesDir, { recursive: true });
  if (!isDev) {
    const bundledInstances = path.join(app.getAppPath(), 'instances');
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
      animationSpeed: 'normal',
      playAnimationSpeed: 'relaxed',
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
  const requestedSidebarOrder = Array.isArray(settings.sidebarOrder) ? settings.sidebarOrder.filter(page => sidebarPages.includes(page)) : [];
  const sidebarOrder = [...new Set(requestedSidebarOrder), ...sidebarPages.filter(page => !requestedSidebarOrder.includes(page))];
  const newsEnabled = settings.newsEnabled !== false;
  const pinnedInstances = Array.isArray(settings.pinnedInstances) ? [...new Set(settings.pinnedInstances.filter(folder => typeof folder === 'string'))] : [];
  const modsInstanceFolder = typeof settings.modsInstanceFolder === 'string' ? settings.modsInstanceFolder : '';
  return { ...settings, animationSpeed, playAnimationSpeed, showPlaytime, playtimePosition, showFriendsBox, showQuickLaunch, performanceModsEnabledByDefault, utilityModsEnabledByDefault, useTLSkinsEnabledByDefault, newsEnabled, sidebarOrder, pinnedInstances, modsInstanceFolder, profiles: normalizedProfiles, selectedProfileId: selectedProfile.id, profile: selectedProfile };
}

function publicSettings(settings) {
  const normalized = normalizeSettings(settings);
  const publicProfiles = normalized.profiles.map(({ refreshTokenEncrypted, ...profile }) => profile);
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
      const detail = body.error_description || body.Message || body.error || `HTTP ${response.status}`;
      throw new Error(String(detail));
    }
    return body;
}

async function exchangeMicrosoftForMinecraft(msaAccessToken) {
  const xbox = await requestJson('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaAccessToken}` },
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
  const minecraft = await requestJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xsts.Token}` })
  });
  const { response: profileResponse, body: profile } = await fetchJsonResponse('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${minecraft.access_token}`, Accept: 'application/json' }
  });
  if (profileResponse.status === 404) throw new Error('This Microsoft account has no Minecraft: Java Edition profile.');
  if (!profileResponse.ok) throw new Error(profile.errorMessage || `Could not load the Minecraft profile (HTTP ${profileResponse.status}).`);
  if (!profile.id || !profile.name || !minecraft.access_token) throw new Error('Minecraft returned an incomplete profile.');
  const xuid = xsts.DisplayClaims?.xui?.[0]?.xid || xbox.DisplayClaims?.xui?.[0]?.xid || '';
  return { accessToken: minecraft.access_token, uuid: profile.id, name: profile.name, xuid };
}

async function receiveMicrosoftAuthorizationCode(clientId) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('hex');
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const redirectUri = `http://localhost:${address.port}`;
  let timeout;
  const codePromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Microsoft sign-in timed out. Please try again.')), 3 * 60 * 1000);
    server.on('request', (request, response) => {
      const callback = new URL(request.url, redirectUri);
      if (callback.pathname !== '/') {
        response.writeHead(404).end('Not found');
        return;
      }
      if (callback.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Sign-in could not be verified. Return to Eclipse and try again.');
        reject(new Error('Microsoft sign-in could not be verified. Please try again.'));
        return;
      }
      const error = callback.searchParams.get('error');
      const code = callback.searchParams.get('code');
      response.writeHead(error || !code ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(error || !code
        ? '<!doctype html><title>Sign-in cancelled</title><p>Sign-in was not completed. You can close this tab and return to Eclipse.</p>'
        : '<!doctype html><title>Sign-in complete</title><p>Sign-in complete. You can close this tab and return to Eclipse Launcher.</p>');
      if (error) reject(new Error(callback.searchParams.get('error_description') || 'Microsoft sign-in was cancelled.'));
      else if (code) resolve(code);
      else reject(new Error('Microsoft did not return an authorization code.'));
    });
  });

  try {
    const authorize = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    authorize.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'XboxLive.signin offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      prompt: 'select_account'
    }).toString();
    await shell.openExternal(authorize.href);
    const code = await codePromise;
    return { code, verifier, redirectUri };
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

async function addMicrosoftProfile(clientId) {
  const normalizedClientId = String(clientId || '').trim();
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(normalizedClientId)) {
    throw new Error('Enter the Microsoft app Client ID first. Eclipse needs its own registered public app ID to open secure sign-in.');
  }
  const settings = readSettings();
  settings.microsoftClientId = normalizedClientId;
  writeSettings(settings);

  const { code, verifier, redirectUri } = await receiveMicrosoftAuthorizationCode(normalizedClientId);
  const token = await requestJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: normalizedClientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: 'XboxLive.signin offline_access'
    })
  });
  if (!token.access_token || !token.refresh_token) throw new Error('Microsoft sign-in did not return a renewable session. Check that the app registration allows public client flows.');
  const minecraft = await exchangeMicrosoftForMinecraft(token.access_token);
  const profile = {
    id: crypto.randomUUID(),
    type: 'microsoft',
    mode: 'microsoft',
    name: minecraft.name,
    uuid: minecraft.uuid,
    status: 'online',
    refreshTokenEncrypted: encryptRefreshToken(token.refresh_token)
  };
  settings.profiles.push(profile);
  settings.selectedProfileId = profile.id;
  writeSettings(settings);
  return publicSettings(settings);
}

async function refreshMicrosoftSession(profile, settings) {
  if (!settings.microsoftClientId) throw new Error('Add a Microsoft app Client ID in the profile setup first.');
  const token = await requestJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: settings.microsoftClientId,
      grant_type: 'refresh_token',
      refresh_token: decryptRefreshToken(profile),
      scope: 'XboxLive.signin offline_access'
    })
  });
  const session = await exchangeMicrosoftForMinecraft(token.access_token);
  if (profile.uuid && profile.uuid !== session.uuid) throw new Error('The signed-in Minecraft profile does not match this saved account. Reconnect the profile.');
  if (token.refresh_token) {
    const current = readSettings();
    current.profiles = current.profiles.map(saved => saved.id === profile.id
      ? { ...saved, refreshTokenEncrypted: encryptRefreshToken(token.refresh_token), name: session.name, uuid: session.uuid }
      : saved);
    writeSettings(current);
  }
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
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'EclipseLauncher/0.10.30' } });
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
  const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png', 'User-Agent': 'EclipseLauncher/0.10.30' } });
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
      preload: path.join(__dirname, 'preload.js'),
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
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  ensureDirs();
  appendLauncherLog('Launcher', `Eclipse ${app.getVersion()} started.`);

  ipcMain.handle('diagnostics:list', () => listDiagnosticLogs());
  ipcMain.handle('diagnostics:read', (_, id) => readDiagnosticLog(id));
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
      const response = await fetch(skinUrl, { signal: controller.signal, headers: { Accept: 'image/png', 'User-Agent': 'EclipseLauncher/0.10.30' } });
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

  ipcMain.handle('accounts:login-microsoft', async (_, clientId) => addMicrosoftProfile(clientId));
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

  ipcMain.handle('instance:create', async (_, options = {}) => {
    ensureDirs();
    const name = typeof options.name === 'string' ? options.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 32) throw new Error('Enter an instance name between 1 and 32 characters long.');
    const version = typeof options.version === 'string' ? options.version.trim() : '';
    if (!version || !/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(version) || version.length > 24) throw new Error('Choose a Minecraft Version');
    const loader = String(options.loader || '').toLowerCase();
    if (!['vanilla', 'fabric', 'forge'].includes(loader)) throw new Error('Choose Vanilla, Fabric, or Forge.');
    const icons = new Set(['', 'ironsword445x445.png', 'heartlogo266x266.png', 'hardcore-heart402x402.png', 'hacker-head187x187.png', 'golden-apple144x144.png']);
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
    const metadata = { name, version, loader: loader[0].toUpperCase() + loader.slice(1), icon, customInstance: true, createdBy: 'user', lastPlayed: 0, playtimeMs: 0, builtInMods: [], eclipseCustomization: true, eclipseCustomizationBuiltInMods: [], eclipseBuiltInResourcePacks: [], performanceMods: requestedPerformanceMods, utilityMods: requestedUtilityMods, addOptiFine, optifineForgeVersion, useTLSkins };
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
    const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const releases = (manifest.versions || []).filter(version => version.type === 'release').map(version => version.id);
    const selectedLoader = String(loader || 'vanilla').toLowerCase();
    if (selectedLoader === 'vanilla') return releases;
    if (selectedLoader === 'fabric') {
      const fabricVersions = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
      const supported = new Set((fabricVersions || []).filter(item => item.stable).map(item => item.version));
      return releases.filter(version => supported.has(version));
    }
    if (selectedLoader === 'forge') {
      const response = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', { headers: { 'User-Agent': 'EclipseLauncher/0.10.30' } });
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

  ipcMain.handle('instance:rename', (_, folder, requestedName, requestedIcon) => {
    if (typeof folder !== 'string' || !folder || path.basename(folder) !== folder) {
      throw new Error('That Minecraft instance could not be found.');
    }
    const name = typeof requestedName === 'string' ? requestedName.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new Error('Enter a name for this instance.');
    if (name.length > 32) throw new Error('Instance names must be 32 characters or fewer.');
    const iconOptions = new Set(['', 'ironsword445x445.png', 'heartlogo266x266.png', 'hardcore-heart402x402.png', 'hacker-head187x187.png', 'golden-apple144x144.png']);
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
    const nextMetadata = { ...metadata, name, icon: requestedIcon };
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
    await ensureEclipseEssentialsPack(event, folder, instanceDir, metadata);
    const runtimeComponent = metadata.runtimeComponent || (release.version === '26.2' ? 'java-runtime-epsilon' : 'java-runtime-gamma');
    const runtimeVersion = metadata.runtimeVersion || (release.version === '26.2' ? '25.0.1' : '17.0.15');
    if (!hasSafeRuntimeMetadata(runtimeComponent, runtimeVersion)) throw new Error('This instance has invalid Java runtime metadata.');
    const javaPath = runtimeJavaPath(runtimeComponent, runtimeVersion);
    const javaProbePath = runtimeJavaProbePath(runtimeComponent, runtimeVersion);

    const launcher = new Client();
    // MCLC uses its javaPath both to probe `-version` and to spawn the game. javaw.exe
    // is ideal for the game window, but suppresses the version text MCLC's probe expects.
    // Probe its companion java.exe while keeping javaw.exe as the actual game process.
    configureLauncherHandler(launcher, javaProbePath, instanceDir);
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
          ? { type: 'msa', demo: false, xuid: microsoftSession.xuid, clientId: settings.microsoftClientId }
          : { type: 'legacy', demo: false }
      },
      root: instanceDir,
      version: {
        number: release.version,
        type: metadata.versionType || 'release',
        ...(release.launchProfile ? { custom: release.launchProfile } : {})
      },
      javaPath,
      memory: { min: '1G', max: '4G' }
    };

    let lastLaunchError = null;
    let earlyExitCode = null;
    let minecraftReady = false;
    let playtimeSession = null;
    let gameProcess = null;
    let loggedMinecraftErrors = 0;
    const reportLaunchProgress = createThrottledLaunchProgress(event, folder);
    const launchProgress = createLaunchProgressReporter(reportLaunchProgress);
    launchProgress.advance(5, true);
    const markMinecraftReady = () => {
      if (minecraftReady) return;
      minecraftReady = true;
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
    launcher.on('debug', msg => {
      const message = String(msg);
      if (message.includes('[MCLC]: Failed to start due to')) {
        lastLaunchError = message.replace(/^.*?Failed to start due to /, '').replace(/, closing\.\.\.$/, '');
        console.error('[Minecraft launcher]', lastLaunchError);
      }
    });
    launcher.on('data', msg => {
      const output = String(msg);
      const mods = output.match(/Loading (\d+) mods:/);
      if (mods) reportLaunchProgress({ phase: 'minecraft-startup', status: `Loading ${mods[1]} mods`, percent: null });
      if (/Loading \d+ mods:/.test(output)) launchProgress.advance(92, true);
      // Recent Minecraft releases log this after creating the game window and
      // completing client startup. The older 26.2-only check left newer releases
      // (such as 26.3) showing Eclipse's loading state after Minecraft was ready.
      if (/Game took [\d.]+ seconds to start/.test(output) || /Sound engine started/.test(output)) markMinecraftReady();
      if (loggedMinecraftErrors < 12) {
        for (const line of output.split(/\r?\n/)) {
          if (/\/(?:ERROR|FATAL)\]|Exception in thread|\bFATAL\b/.test(line)) {
            console.error('[Minecraft]', line.slice(0, 500));
            if (++loggedMinecraftErrors >= 12) break;
          }
        }
      }
    });
    launcher.on('close', code => { earlyExitCode = code; });
    launcher.on('download-status', status => {
      launchProgress.report(status.type, status.current, status.total);
    });
    launcher.on('progress', progress => {
      launchProgress.report(progress.type, progress.task, progress.total);
    });
    launcher.on('arguments', () => launchProgress.advance(86, true));

    try {
      // Some loader/customization setup can rewrite options.txt during preparation;
      // re-assert the bundled pack immediately before the game reads its options.
      await ensureEclipseEssentialsPack(event, folder, instanceDir, metadata);
      gameProcess = await launcher.launch(opts);
      if (!gameProcess || !gameProcess.pid) {
        const detail = lastLaunchError || (earlyExitCode != null ? `Minecraft exited before opening (exit code ${earlyExitCode}).` : 'The Minecraft process could not be started.');
        throw new Error(detail);
      }
      activeInstanceLaunches.set(folder, gameProcess);
      appendLauncherLog('Launch', `${String(metadata.name || folder)} started with PID ${gameProcess.pid}.`);
      gameProcess.once('error', error => {
        if (activeInstanceLaunches.get(folder) !== gameProcess) return;
        activeInstanceLaunches.delete(folder);
        appendLauncherLog('Launch error', `[${folder}] Minecraft process error: ${error?.stack || error}`);
        const playtimeMs = playtimeSession?.stop();
        sendLaunchStatus(event, folder, { state: 'failed', message: error.message, playtimeMs });
      });
      gameProcess.once('close', (code, signal) => {
        if (activeInstanceLaunches.get(folder) !== gameProcess) return;
        activeInstanceLaunches.delete(folder);
        const playtimeMs = playtimeSession?.stop();
        appendLauncherLog('Launch', `${String(metadata.name || folder)} closed with ${code == null ? 'no exit code' : `exit code ${code}`}${signal ? ` (${signal})` : ''}.`);
        sendLaunchStatus(event, folder, { state: 'closed', code, signal, playtimeMs });
      });
      if (minecraftReady) {
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
