const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { Client, Authenticator } = require('minecraft-launcher-core');

const launcher = new Client();

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

// Function to copy all custom client assets into the target .minecraft directory
async function syncClientFiles(targetDir) {
    const sourceDir = path.join(__dirname, 'client-files');

    try {
        if (await fs.pathExists(sourceDir)) {
            await fs.copy(sourceDir, targetDir, { overwrite: true });
            console.log("Eclipse Client files successfully synced!");
        } else {
            console.log("No client-files directory found. Creating empty template folder...");
            await fs.ensureDir(sourceDir);
        }
    } catch (err) {
        console.error("Error syncing client files:", err);
    }
}

ipcMain.on('launch-game', async (event, username) => {
    const gameRoot = path.join(__dirname, '.minecraft');

    // 1. Sync mods, configs, resourcepacks, options before launching
    event.reply('launch-progress', { type: 'status', task: "Syncing client files..." });
    console.log("Syncing client setup...");
    await syncClientFiles(gameRoot);

    // 2. Direct Version Launching using official installed Fabric profile
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