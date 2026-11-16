// Renders build/icon.png (run with: npx electron build/make-icon.js)
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<rect width="1024" height="1024" rx="200" fill="#12161c"/>
<g fill="none" stroke="#2f6b4a" stroke-width="10"><circle cx="512" cy="512" r="380"/><circle cx="512" cy="512" r="250"/><circle cx="512" cy="512" r="120"/></g>
<path d="M190 800 Q420 700 560 520" fill="none" stroke="#3ddc84" stroke-width="22" stroke-linecap="round" stroke-dasharray="2 46"/>
<g transform="translate(600 440) rotate(40) scale(13)" fill="#3ddc84"><path d="M0 -20 L3.5 -8 L20 4 L20 8 L3.5 3 L2.5 14 L8 18 L8 21 L0 19 L-8 21 L-8 18 L-2.5 14 L-3.5 3 L-20 8 L-20 4 L-3.5 -8 Z"/></g>
</svg>`;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent;overflow:hidden">${svg}</body>`));
  await new Promise(r => setTimeout(r, 500));
  const img = (await w.webContents.capturePage()).resize({ width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  app.quit();
});
