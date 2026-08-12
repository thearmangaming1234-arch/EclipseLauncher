const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const http = require('http');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

// Prevent multiple instances of the app from launching
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

app.disableHardwareAcceleration();

const launcher = new Client();
const msmcAuth = new Auth("select_account");

const MANIFEST_URL = 'https://raw.githubusercontent.com/thearmangaming1234-arch/EclipseLauncher/main/manifest.json';
const CLIENT_FILES_DIR = path.join(__dirname, 'client-files');
const GAME_ROOT = path.join(__dirname, '.minecraft');

let mainWindow = null;

const ALWAYS_SYNC_PATHS = [
    'fancymenu_data', 'kubejs', 'local', 'mods', 'versions',
    'config/fancymenu', 'config/drippyloadingscreen', 'config/fabric',
    'config/konkrete', 'config/paxi', 'config/builtinservers.json',
    'config/craftpresence.json', 'config/watermedia.toml'
];

const PROTECTED_USER_FILES = [
    'options.txt', 'optionsof.txt', 'servers.dat', 'servers.dat_old', 'crosshair_config.ccmcfg'
];

function shouldSkipSync(relativePath, targetFullPath) {
    if (!fs.existsSync(targetFullPath)) return false;

    const normalized = relativePath.replace(/\\/g, '/');
    const isForcedSystemPath = ALWAYS_SYNC_PATHS.some(forcedPath => 
        normalized === forcedPath || normalized.startsWith(forcedPath + '/') || normalized.endsWith(forcedPath)
    );
    if (isForcedSystemPath) return false;

    if (PROTECTED_USER_FILES.some(file => normalized.endsWith(file))) return true;
    if (normalized.startsWith('resourcepacks/') || normalized.startsWith('config/')) return true;

    return false;
}

function isGameInstalled() {
    const versionDir = path.join(GAME_ROOT, 'versions');
    if (fs.existsSync(GAME_ROOT) && fs.existsSync(versionDir)) {
        try {
            return fs.readdirSync(versionDir).length > 0;
        } catch (e) {
            return false;
        }
    }
    return false;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        frame: false,
        resizable: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        icon: path.join(__dirname, 'assets/logo.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('install-status', isGameInstalled());
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

// Force application exit when windows are closed
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

ipcMain.on('window-min', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { 
    if (mainWindow) mainWindow.close(); 
    app.quit();
});
ipcMain.on('get-game-path', (event) => { event.reply('game-path', GAME_ROOT); });

ipcMain.on('check-install-status', (event) => {
    event.reply('install-status', isGameInstalled());
});

/* ==========================================================
   LAUNCHER GAME & UPDATES LOGIC
   ========================================================== */

ipcMain.on('ms-login-start', async (event) => {
    try {
        const xboxManager = await msmcAuth.launch("electron");
        const token = await xboxManager.getMinecraft();

        if (token && token.mclc()) {
            event.reply('ms-login-success', {
                name: token.mclc().name,
                token: JSON.stringify(token)
            });
        } else {
            event.reply('ms-login-error', "Invalid credentials");
        }
    } catch (err) {
        event.reply('ms-login-error', err.toString());
    }
});

function fetchManifest() {
    return new Promise((resolve, reject) => {
        const req = https.get(MANIFEST_URL, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));

            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', (err) => fs.unlink(dest, () => reject(err)));
        });
        req.on('error', (err) => fs.unlink(dest, () => reject(err)));
        req.setTimeout(15000, () => { req.destroy(); fs.unlink(dest, () => reject(new Error("Timeout"))); });
    });
}

async function checkAndDownloadUpdates(event) {
    try {
        event.reply('download-progress', { percent: 0, task: "Verifying files..." });
        const manifest = await fetchManifest();
        if (manifest.files && manifest.files.length > 0) {
            let count = 0;
            const total = manifest.files.length;
            for (const item of manifest.files) {
                count++;
                const targetFilePath = path.join(GAME_ROOT, item.path);
                if (shouldSkipSync(item.path, targetFilePath)) continue;

                const percent = Math.round((count / total) * 100);
                
                event.reply('download-progress', { 
                    percent: percent, 
                    task: "Verifying files..." 
                });

                try {
                    await fs.ensureDir(path.dirname(targetFilePath));
                    await downloadFile(item.url, targetFilePath);
                } catch (fileErr) {
                    console.warn(`[SKIP] ${item.path}: ${fileErr.message}`);
                }
            }
        }
    } catch (err) {
        console.warn("Update check failed:", err.message);
    }
}

async function syncClientFiles(targetDir) {
    try {
        if (await fs.pathExists(CLIENT_FILES_DIR)) {
            await fs.copy(CLIENT_FILES_DIR, targetDir, {
                overwrite: true,
                errorOnExist: false,
                filter: (src) => {
                    const relativePath = path.relative(CLIENT_FILES_DIR, src);
                    if (!relativePath) return true;
                    return !shouldSkipSync(relativePath, path.join(targetDir, relativePath));
                }
            });
        }
    } catch (err) {
        console.warn("Client sync warning:", err.message);
    }
}

ipcMain.on('start-download', async (event) => {
    try {
        await fs.ensureDir(GAME_ROOT);
        await checkAndDownloadUpdates(event);
        await syncClientFiles(GAME_ROOT);
        
        event.reply('install-status', isGameInstalled());
    } catch (err) {
        event.reply('launch-error', "Download failed!");
    }
});

ipcMain.on('launch-game', async (event, data) => {
    // Extract nested settings sent from index.html
    const settings = data.settings || {};
    const authType = data.authType || 'cracked';
    const ramInMb = settings.ram || "3584";
    const behavior = settings.behavior || "hide";
    const width = parseInt(settings.width) || 854;
    const height = parseInt(settings.height) || 480;
    const fullscreen = Boolean(settings.fullscreen);

    let authHeader;
    if (authType === 'microsoft' && data.msToken) {
        try {
            const refreshAuth = await msmcAuth.refresh(JSON.parse(data.msToken));
            authHeader = (await refreshAuth.getMinecraft()).mclc();
        } catch (e) {
            authHeader = Authenticator.getAuth(data.username || "Player");
        }
    } else {
        // Cracked/Offline auth mode
        authHeader = Authenticator.getAuth(data.username || "Player");
    }

    const defaultJvmFlags = [
        "-Dfabric.log.level=info", "-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled",
        "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC"
    ];
    const userJvmFlags = settings.jvmFlags ? settings.jvmFlags.trim().split(/\s+/).filter(Boolean) : [];

    // Sync client blueprint files and manifest updates
    await checkAndDownloadUpdates(event);
    await syncClientFiles(GAME_ROOT);

    // Configured for custom fabric loader profile
    let opts = {
        authorization: authHeader,
        root: GAME_ROOT,
        version: { 
            number: "1.20.1", 
            type: "release",
            custom: "fabric-loader-0.19.3-1.20.1"
        },
        memory: { max: `${ramInMb}M`, min: "1024M" },
        window: { width, height, fullscreen },
        customArgs: [...defaultJvmFlags, ...userJvmFlags]
    };

    launcher.removeAllListeners();

    let hasTriggeredLaunch = false;

    // Event listeners for launcher state & status reporting
    launcher.on('debug', (e) => console.log('[LAUNCHER DEBUG]', e));
    launcher.on('data', (e) => {
        console.log('[MINECRAFT LOG]', e);
        if (!hasTriggeredLaunch && (e.includes('Setting user:') || e.includes('Loading Minecraft') || e.includes('OpenAL initialized'))) {
            hasTriggeredLaunch = true;
            event.reply('game-launched');

            if (behavior === 'hide' && mainWindow) {
                mainWindow.hide();
            } else if (behavior === 'close') {
                app.quit();
            }
        }
    });

    let currentStep = 0;
    launcher.on('progress', (e) => {
        currentStep++;
        let percent = 0;
        if (e.total && e.total > 0) {
            percent = Math.min(100, Math.round((e.current / e.total) * 100));
        } else {
            // Smooth progress estimation when e.total is missing
            percent = Math.min(99, currentStep * 5);
        }

        event.reply('download-progress', {
            percent: percent,
            task: "Verifying files..."
        });
    });

    launcher.on('close', (code) => {
        console.log('[GAME CLOSED]', code);
        if (behavior === 'hide' && mainWindow) {
            mainWindow.show();
        }
        event.reply('install-status', isGameInstalled());
        event.reply('game-closed');
    });

    try {
        event.reply('download-progress', { percent: 100, task: "An Eclipse is forming..." });
        await launcher.launch(opts);
    } catch (err) {
        console.error("Failed to launch game:", err);
        event.reply('launch-error', err.message || "Launch failed!");
    }
});