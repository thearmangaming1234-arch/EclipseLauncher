const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const source = path.join(__dirname, 'update-screen.cs');
const output = path.join(__dirname, 'EclipseUpdateScreen.exe');
if (!fs.existsSync(compiler)) throw new Error(`Windows .NET Framework compiler was not found: ${compiler}`);
const result = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${output}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', source], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log('Built the standalone Eclipse update screen helper.');
