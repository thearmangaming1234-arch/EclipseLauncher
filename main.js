const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const { Client, Authenticator } = require('minecraft-launcher-core');

const launcher = new Client();

const MANIFEST_URL = 'https://raw.githubusercontent.com/thearmangaming1234-arch/EclipseLauncher/main/manifest.json';
const CLIENT_FILES_DIR = path.join(__dirname, 'client-files');

function createWindow() {
    const win = new BrowserWindow({
        width: 900,
        height: 600,
        frame: false,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

// Helper to fetch JSON manifest from GitHub
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

// Function to download a single file from a remote URL
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

// Fetch remote manifest and sync missing remote files into client-files
async function checkAndDownloadUpdates(event) {
    try {
        event.reply('launch-progress', { type: 'status', task: "Checking for remote updates..." });
        const manifest = await fetchManifest();
        console.log("Remote Manifest Version:", manifest.version);

        if (manifest.files && manifest.files.length > 0) {
            for (const item of manifest.files) {
                // item expected format: { path: "mods/example.jar", url: "..." }
                const localFilePath = path.join(CLIENT_FILES_DIR, item.path);
                if (!await fs.pathExists(localFilePath)) {
                    event.reply('launch-progress', { type: 'status', task: `Downloading update: ${path.basename(item.path)}...` });
                    await fs.ensureDir(path.dirname(localFilePath));
                    await downloadFile(item.url, localFilePath);
                }
            }
        }
    } catch (err) {
        console.warn("Could not check online updates (offline or link unreachable). Continuing with local files...", err);
    }
}

// Sync client-files into .minecraft directory
async function syncClientFiles(targetDir) {
    try {
        if (await fs.pathExists(CLIENT_FILES_DIR)) {
            await fs.copy(CLIENT_FILES_DIR, targetDir, { overwrite: true });
            console.log("Eclipse Client files successfully synced!");
        } else {
            console.log("No client-files directory found. Creating empty folder...");
            await fs.ensureDir(CLIENT_FILES_DIR);
        }
    } catch (err) {
        console.error("Error syncing client files:", err);
    }
}

ipcMain.on('launch-game', async (event, username) => {
    const gameRoot = path.join(__dirname, '.minecraft');

    // 1. Check GitHub for any remote file updates first
    await checkAndDownloadUpdates(event);

    // 2. Sync mods, configs, resourcepacks, options into target .minecraft directory
    event.reply('launch-progress', { type: 'status', task: "Syncing client files..." });
    console.log("Syncing client setup...");
    await syncClientFiles(gameRoot);

    // 3. Launch Fabric Minecraft
    let opts = {
        javaPath: "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.8-hotspot\\bin\\java.exe",
        authorization: Authenticator.getAuth(username),
        root: gameRoot,
        version: {
            number: "1.20.1",
            type: "release",
            custom: "fabric-loader-0.19.3-1.20.1"
        },
        memory: {
            max: "4G",
            min: "2G"
        }
    };

    launcher.launch(opts);

    launcher.on('debug', (e) => console.log("[DEBUG]", e));
    launcher.on('data', (e) => console.log("[DATA]", e));
    
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
        console.log("Game closed with code:", code);
    });
});