const fs = require('fs');
const path = require('path');

// Configuration
const GITHUB_USER = 'thearmangaming1234-arch';
const REPO_NAME = 'EclipseLauncher';
const BRANCH = 'main';
const CLIENT_FILES_DIR = path.join(__dirname, 'client-files');
const MANIFEST_FILE = path.join(__dirname, 'manifest.json');

const RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${REPO_NAME}/${BRANCH}/client-files/`;

// Direct download URL for large files hosted on GitHub Releases
const WATERMEDIA_RELEASE_URL = 'https://github.com/thearmangaming1234-arch/EclipseLauncher/releases/download/v1.0.0-assets/watermedia_binaries-3.0.0-rc.4.jar';

// Helper function to safely format GitHub Raw URLs (keeps '+' intact for Fabric mod names)
function buildGitHubUrl(relativePath) {
    const cleanPath = relativePath
        .split('/')
        .map(segment => encodeURIComponent(segment).replace(/%2B/gi, '+'))
        .join('/');
    return `${RAW_BASE_URL}${cleanPath}`;
}

// Recursive function to scan all files inside client-files folder
function getFilesRecursively(dir, baseDir = dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;

    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getFilesRecursively(filePath, baseDir));
        } else {
            // SKIP watermedia_binaries from regular raw github scanning
            if (file.toLowerCase().includes('watermedia_binaries')) {
                return;
            }

            // Get relative path (e.g., config/fancymenu/custom.cfg)
            const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
            results.push({
                path: relativePath,
                url: buildGitHubUrl(relativePath)
            });
        }
    });
    return results;
}

console.log('🔄 Scanning client-files directory...');
const files = getFilesRecursively(CLIENT_FILES_DIR);

// Automatically add the Watermedia mod pointing directly to GitHub Releases
files.push({
    path: "mods/watermedia_binaries-3.0.0-rc.4.jar",
    url: WATERMEDIA_RELEASE_URL
});

const manifestData = {
    version: Date.now(), // Auto-timestamp version so launcher knows it updated
    files: files
};

fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifestData, null, 2));
console.log(`✅ Success! Generated manifest.json with ${files.length} file(s) (including Watermedia Release link).`);