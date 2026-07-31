const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const http = require('http');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const launcher = new Client();
const msmcAuth = new Auth("select_account");

const MANIFEST_URL = 'https://raw.githubusercontent.com/thearmangaming1234-arch/EclipseLauncher/main/manifest.json';
const CLIENT_FILES_DIR = path.join(__dirname, 'client-files');
const GAME_ROOT = path.join(__dirname, '.minecraft');

let mainWindow = null;

// Paths that MUST always be updated/overwritten (UI, scripts, branding, mods)
const ALWAYS_SYNC_PATHS = [
    'fancymenu_data',
    'kubejs',
    'local',
    'mods',
    'config/fancymenu',
    'config/drippyloadingscreen',
    'config/fabric',
    'config/konkrete',
    'config/paxi',
    'config/builtinservers.json',
    'config/craftpresence.json',
    'config/watermedia.toml'
];

// Specific user preference files that should NEVER be overwritten once created
const PROTECTED_USER_FILES = [
    'options.txt',
    'optionsof.txt',
    'servers.dat',
    'servers.dat_old',
    'crosshair_config.ccmcfg'
];

/**
 * Smart file filter to balance forced client updates with user config preservation
 */
function shouldSkipSync(relativePath, targetFullPath) {
    // If destination file doesn't exist yet, NEVER skip (Fresh install initial copy!)
    if (!fs.existsSync(targetFullPath)) {
        return false; 
    }

    const normalized = relativePath.replace(/\\/g, '/');

    // 1. Force updates for branded assets, scripts, mods & UI configurations
    const isForcedSystemPath = ALWAYS_SYNC_PATHS.some(forcedPath => {
        return normalized === forcedPath || 
               normalized.startsWith(forcedPath + '/') || 
               normalized.endsWith(forcedPath);
    });
    if (isForcedSystemPath) {
        return false; // Force update/overwrite
    }

    // 2. Protect keybinds, option files, and custom crosshairs
    const isProtectedFile = PROTECTED_USER_FILES.some(file => normalized.endsWith(file));
    if (isProtectedFile) {
        return true;
    }

    // 3. Protect user resourcepacks
    if (normalized.startsWith('resourcepacks/')) {
        return true;
    }

    // 4. Protect remaining config files by default (Sodium, Fullbright toggle, etc.)
    if (normalized.startsWith('config/')) {
        return true;
    }

    return false; // Sync everything else by default
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
}

app.whenReady().then(createWindow);

ipcMain.on('window-min', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('get-game-path', (event) => {
    event.reply('game-path', GAME_ROOT);
});

/* Microsoft Login Flow */
ipcMain.on('ms-login-start', async (event) => {
    try {
        const xboxManager = await msmcAuth.launch("electron");
        const token = await xboxManager.getMinecraft();

        if (token && token.mclc()) {
            const profile = token.mclc();
            event.reply('ms-login-success', {
                name: profile.name,
                token: token
            });
        } else {
            event.reply('ms-login-error', "Invalid credentials");
        }
    } catch (err) {
        console.error("Microsoft auth error:", err);
        event.reply('ms-login-error', err.toString());
    }
});

function fetchManifest() {
    return new Promise((resolve, reject) => {
        https.get(MANIFEST_URL, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

/**
 * Robust downloader that follows HTTP/HTTPS redirects for raw GitHub files
 */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        protocol.get(url, (response) => {
            // Follow redirects (HTTP 301, 302, 303, 307, 308)
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
            }

            const file = fs.createWriteStream(dest);
            response.pipe(file);

            file.on('finish', () => {
                file.close(resolve);
            });

            file.on('error', (err) => {
                fs.unlink(dest, () => reject(err));
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

async function checkAndDownloadUpdates(event) {
    try {
        event.reply('launch-progress', { type: 'status', task: "Checking for updates..." });
        const manifest = await fetchManifest();

        if (manifest.files && manifest.files.length > 0) {
            for (const item of manifest.files) {
                const localFilePath = path.join(CLIENT_FILES_DIR, item.path);

                if (shouldSkipSync(item.path, localFilePath)) {
                    continue;
                }

                event.reply('launch-progress', { type: 'status', task: `Updating: ${path.basename(item.path)}...` });
                await fs.ensureDir(path.dirname(localFilePath));
                await downloadFile(item.url, localFilePath);
            }
        }
    } catch (err) {
        console.warn("Could not check online updates. Continuing local...", err);
    }
}

async function syncClientFiles(targetDir) {
    try {
        if (await fs.pathExists(CLIENT_FILES_DIR)) {
            // Smart Copy: Protect local player options/keybinds from being overwritten by local client-files
            await fs.copy(CLIENT_FILES_DIR, targetDir, {
                overwrite: true,
                filter: (src) => {
                    const relativePath = path.relative(CLIENT_FILES_DIR, src);
                    if (!relativePath) return true; // root folder

                    const targetPath = path.join(targetDir, relativePath);
                    if (shouldSkipSync(relativePath, targetPath)) {
                        return false; // Skip copying to preserve user's game settings
                    }
                    return true;
                }
            });
        } else {
            await fs.ensureDir(CLIENT_FILES_DIR);
        }
    } catch (err) {
        console.error("Error syncing client files:", err);
    }
}

ipcMain.on('launch-game', async (event, data) => {
    const authType = data.authType || 'cracked';
    const ramInMb = data.ram || "4096";
    const behavior = data.behavior || "hide";

    let authHeader;

    if (authType === 'microsoft' && data.msToken) {
        try {
            const rawToken = JSON.parse(data.msToken);
            const refreshAuth = await msmcAuth.refresh(rawToken);
            const refreshedToken = await refreshAuth.getMinecraft();
            authHeader = refreshedToken.mclc();
        } catch (e) {
            console.error("Failed to refresh Microsoft token, falling back to cached token or offline", e);
            authHeader = Authenticator.getAuth(data.username);
        }
    } else {
        authHeader = Authenticator.getAuth(data.username);
    }

    const customArgs = data.jvmFlags ? data.jvmFlags.trim().split(/\s+/).filter(Boolean) : [];

    await checkAndDownloadUpdates(event);

    event.reply('launch-progress', { type: 'status', task: "Verifying client files..." });
    await syncClientFiles(GAME_ROOT);

    let opts = {
        javaPath: "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.8-hotspot\\bin\\java.exe",
        authorization: authHeader,
        root: GAME_ROOT,
        version: {
            number: "1.20.1",
            type: "release",
            custom: "fabric-loader-0.19.3-1.20.1"
        },
        memory: {
            max: `${ramInMb}M`,
            min: "1024M"
        },
        window: {
            width: parseInt(data.width) || 854,
            height: parseInt(data.height) || 480,
            fullscreen: data.fullscreen || false
        },
        customArgs: customArgs
    };

    launcher.launch(opts);

    launcher.on('debug', (e) => console.log("[DEBUG]", e));
    
    launcher.on('data', (e) => {
        if (e.includes('Setting user:') || e.includes('Loading Minecraft')) {
            event.reply('game-started');

            if (behavior === 'hide') {
                if (mainWindow) mainWindow.hide();
            } else if (behavior === 'close') {
                app.quit();
            }
        }
    });

    launcher.on('progress', (e) => {
        let percentage = 0;
        if (e.total && e.total > 0) {
            percentage = Math.round((e.task / e.total) * 100);
        }

        event.reply('launch-progress', {
            type: 'progress',
            task: e.task,
            total: e.total,
            percentage: percentage
        });
    });

    launcher.on('close', (code) => {
        if (behavior === 'hide' && mainWindow) {
            mainWindow.show();
        }
        event.reply('game-closed');
    });
});