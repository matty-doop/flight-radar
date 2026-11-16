// Desktop app wrapper: runs the tracker's server inside the app and shows it in its own window.
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const net = require('net');
const path = require('path');

const PREFERRED_PORT = 8643; // a fixed port keeps saved settings between launches

function freePort(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(port ? freePort(0) : 0));
    s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---- Updates ----
// The Windows installer version updates itself. The Mac app and the portable exe cannot
// (Mac needs a paid signing certificate), so they just say when a newer version is out.
const RELEASES = 'https://github.com/matty-doop/flight-radar/releases/latest';
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let told = '';
async function noticeOnly() {
  try {
    const r = await fetch('https://api.github.com/repos/matty-doop/flight-radar/releases/latest', { headers: { 'User-Agent': 'flight-radar-app', Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const v = String((await r.json()).tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(v) || !newer(v, app.getVersion()) || told === v || !win || win.isDestroyed()) return;
    told = v;
    const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1, message: `Flight Radar ${v} is available`, detail: `You have ${app.getVersion()}. Download the new version and replace this one.` });
    if (response === 0) shell.openExternal(RELEASES);
  } catch {}
}
function watchForUpdates() {
  if (!app.isPackaged) return;
  let check = noticeOnly;
  if (process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('error', () => {});
    autoUpdater.on('update-downloaded', async info => {
      if (told === info.version || !win || win.isDestroyed()) return;
      told = info.version;
      const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, message: `Flight Radar ${info.version} is ready`, detail: 'It will be installed the next time the app starts.' });
      if (response === 0) autoUpdater.quitAndInstall();
    });
    check = () => autoUpdater.checkForUpdates().catch(() => {});
  }
  setTimeout(check, 15e3);
  setInterval(check, 6 * 3600e3); // the app may be left running all day
}


let win;
async function start() {
  const port = await freePort(PREFERRED_PORT);
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';       // this computer only
  delete process.env.APP_PASSWORD;
  process.env.DATA_DIR = app.getPath('userData');
  require('./server.js');

  const home = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 500,
    backgroundColor: '#12161c', title: 'Flight Radar', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Links to other sites open in the normal browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(home)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  const load = (n = 0) => win.loadURL(home).catch(() => { if (n < 20 && !win.isDestroyed()) setTimeout(() => load(n + 1), 250); });
  load();
  watchForUpdates();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
      { role: 'windowMenu' },
    ]));
    start();
  });
  app.on('window-all-closed', () => app.quit());
}
