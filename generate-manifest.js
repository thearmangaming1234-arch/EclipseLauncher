const fs = require('fs');
const path = require('path');

// Configuration
const GITHUB_USER = 'thearmangaming1234-arch';
const REPO_NAME = 'EclipseLauncher';
const BRANCH = 'main';
const CLIENT_FILES_DIR = path.join(__dirname, 'client-files');
const MANIFEST_FILE = path.join(__dirname, 'manifest.json');

const RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${REPO_NAME}/${BRANCH}/client-files/`;

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
            // Get relative path (e.g., config/fancymenu/custom.cfg)
            const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
            results.push({
                path: relativePath,
                url: `${RAW_BASE_URL}${relativePath}`
            });
        }
    });
    return results;
}

console.log('🔄 Scanning client-files directory...');
const files = getFilesRecursively(CLIENT_FILES_DIR);

const manifestData = {
    version: Date.now(), // Auto-timestamp version so launcher knows it updated
    files: files
};

fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifestData, null, 2));
console.log(`✅ Success! Generated manifest.json with ${files.length} file(s).`);