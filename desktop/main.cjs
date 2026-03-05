const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

let tray;
let win;
let serverProc = null;
let loginProc = null;
const store = new Store({ name: 'cursor-gateway-desktop' });
let firstRunGuideShown = false;

const appRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(appRoot, 'src', 'app.js');
const loginEntry = path.join(appRoot, 'src', 'tool', 'cursorLogin.js');
const port = process.env.PORT || '3010';
const baseURL = `http://127.0.0.1:${port}`;
const tokenFile = path.join(appRoot, '.cursor-token');

function tokenStatus() {
  try {
    if (!fs.existsSync(tokenFile)) return { ok: false, msg: '未检测到 .cursor-token，请先点击“Cursor 登录”。' };
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!t) return { ok: false, msg: '.cursor-token 为空，请重新登录。' };
    return { ok: true, msg: '已检测到有效 token。' };
  } catch (e) {
    return { ok: false, msg: `读取 token 失败: ${String(e)}` };
  }
}

function spawnNodeScript(entry) {
  return spawn(process.execPath, [entry], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function startServer() {
  if (serverProc) return;
  serverProc = spawnNodeScript(serverEntry);
  serverProc.stdout.on('data', d => console.log(`[server] ${d}`));
  serverProc.stderr.on('data', d => console.error(`[server] ${d}`));
  serverProc.on('exit', () => {
    serverProc = null;
    refreshMenu();
  });
  refreshMenu();
}

function stopServer() {
  if (!serverProc) return;
  serverProc.kill('SIGTERM');
  serverProc = null;
  refreshMenu();
}

function runLoginFlow() {
  if (loginProc) return;
  loginProc = spawnNodeScript(loginEntry);
  let out = '';
  loginProc.stdout.on('data', d => { out += d.toString(); console.log(`[login] ${d}`); });
  loginProc.stderr.on('data', d => { out += d.toString(); console.error(`[login] ${d}`); });
  loginProc.on('exit', () => {
    dialog.showMessageBox({
      title: 'Cursor 登录结果',
      message: '登录流程已结束',
      detail: out.slice(-3500) || '无输出'
    });
    loginProc = null;
    refreshMenu();
  });
}

async function check(pathname) {
  const url = `${baseURL}${pathname}`;
  try {
    const r = await fetch(url);
    const text = await r.text();
    return { ok: true, url, status: r.status, body: text };
  } catch (e) {
    return { ok: false, url, status: 0, body: String(e) };
  }
}

function openPanel() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 560,
    height: 700,
    title: 'Cursor Gateway Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));
}

function refreshMenu() {
  const running = !!serverProc;
  const menu = Menu.buildFromTemplate([
    { label: running ? '✅ 服务运行中' : '⏸ 服务已停止', enabled: false },
    { type: 'separator' },
    { label: '打开控制面板', click: openPanel },
    { label: '启动服务', enabled: !running, click: startServer },
    { label: '停止服务', enabled: running, click: stopServer },
    { type: 'separator' },
    { label: 'Cursor 登录', click: runLoginFlow },
    { label: '检查 /health', click: async () => {
      const r = await check('/health');
      dialog.showMessageBox({ message: `${r.url}\n\n${r.body.slice(0,3500)}` });
    }},
    { label: '检查 /v1/models', click: async () => {
      const r = await check('/v1/models');
      dialog.showMessageBox({ message: `${r.url}\n\n${r.body.slice(0,3500)}` });
    }},
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

app.whenReady().then(() => {
  ipcMain.handle('gateway:check', (_, path) => check(path || '/health'));
  ipcMain.handle('gateway:start', () => { startServer(); return { ok: true }; });
  ipcMain.handle('gateway:stop', () => { stopServer(); return { ok: true }; });
  ipcMain.handle('gateway:login', () => { runLoginFlow(); return { ok: true }; });
  ipcMain.handle('gateway:status', async () => {
    const t = tokenStatus();
    const h = await check('/health');
    return { token: t, health: h };
  });

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('CG');
  tray.setToolTip('Cursor Gateway Desktop');
  tray.on('click', openPanel);
  refreshMenu();
  startServer();

  setTimeout(() => {
    const t = tokenStatus();
    const guideDismissed = store.get('guideDismissed', false);
    if (!firstRunGuideShown && !guideDismissed && !t.ok) {
      firstRunGuideShown = true;
      dialog.showMessageBox({
        type: "info",
        title: "首次使用引导",
        message: "检测到尚未登录 Cursor",
        detail: "请按顺序操作：\n1) 点击托盘图标打开控制面板\n2) 点击【Cursor 登录】\n3) 点击【状态检测】确认 token 与 /health 正常"
      });
      openPanel();
      store.set('guideDismissed', true);
    }
  }, 1200);
});

app.on('before-quit', () => {
  stopServer();
  if (loginProc) loginProc.kill('SIGTERM');
});
