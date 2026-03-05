const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let tray;
let win;
let splash;
let serverProc = null;
let loginProc = null;
let firstRunGuideShown = false;

const appRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(appRoot, 'src', 'app.js');
const loginEntry = path.join(appRoot, 'src', 'tool', 'cursorLogin.js');
const packagedLoginEntry = path.join(process.resourcesPath || '', 'app.asar', 'src', 'tool', 'cursorLogin.js');
const port = process.env.PORT || '3010';
const baseURL = `http://127.0.0.1:${port}`;
const tokenFile = path.join(appRoot, '.cursor-token');
const runtimeCwd = process.resourcesPath || process.cwd();

function prefFilePath() {
  return path.join(app.getPath('userData'), 'prefs.json');
}

function getGuideDismissed() {
  try {
    const f = prefFilePath();
    if (!fs.existsSync(f)) return false;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Boolean(j.guideDismissed);
  } catch {
    return false;
  }
}

function setGuideDismissed(v) {
  try {
    const f = prefFilePath();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let j = {};
    if (fs.existsSync(f)) {
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { j = {}; }
    }
    j.guideDismissed = Boolean(v);
    fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
  } catch (e) {
    console.error('[prefs] write failed:', e);
  }
}

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
    cwd: runtimeCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      CURSOR_GATEWAY_SESSIONS_DIR: path.join(app.getPath('userData'), 'sessions'),
      CURSOR_GATEWAY_LOG_FILE: path.join(app.getPath('userData'), 'server.log')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}



function startServerEmbedded() {
  if (serverProc) return;
  process.env.PORT = String(port);
  process.env.CURSOR_GATEWAY_SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions');
  process.env.CURSOR_GATEWAY_LOG_FILE = path.join(app.getPath('userData'), 'server.log');
  try {
    require(serverEntry);
    serverProc = { embedded: true, kill: () => {} };
    refreshMenu();
    console.log('[desktop] Server started in embedded mode');
  } catch (e) {
    console.error('[desktop] Embedded server start failed:', e);
  }
}

function startServer() {
  if (serverProc) return;
  if (app.isPackaged) {
    startServerEmbedded();
    return;
  }
  serverProc = spawnNodeScript(serverEntry);
  serverProc.stdout.on('data', d => console.log(`[server] ${d}`));
  serverProc.stderr.on('data', d => console.error(`[server] ${d}`));
  serverProc.on('exit', (code, sig) => {
    console.log(`[server] exited code=${code} sig=${sig}`);
    serverProc = null;
    refreshMenu();
  });
  refreshMenu();
}

function stopServer() {
  if (!serverProc) return;
  if (serverProc.embedded) {
    dialog.showMessageBox({ message: '嵌入模式下暂不支持停止服务，请退出应用后重启。' });
    return;
  }
  serverProc.kill('SIGTERM');
  serverProc = null;
  refreshMenu();
}

function runLoginFlow() {
  if (loginProc) {
    dialog.showMessageBox({ message: '登录流程已在进行中，请完成浏览器登录。' });
    return;
  }

  const loginScript = app.isPackaged ? packagedLoginEntry : loginEntry;
  loginProc = spawnNodeScript(loginScript);
  let out = '';
  let opened = false;

  dialog.showMessageBox({
    type: 'info',
    title: 'Cursor 登录',
    message: '正在启动登录流程',
    detail: '稍后会自动打开浏览器登录链接；若未弹出，请查看结果弹窗中的 URL 手动打开。'
  });

  const onChunk = (d) => {
    const t = d.toString();
    out += t;
    if (!opened) {
      const m = out.match(/https?:\/\/\S+/);
      if (m) {
        opened = true;
        shell.openExternal(m[0]).catch(() => {});
      }
    }
  };

  loginProc.stdout.on('data', d => { console.log(`[login] ${d}`); onChunk(d); });
  loginProc.stderr.on('data', d => { console.error(`[login] ${d}`); onChunk(d); });
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


function createSplash() {
  if (splash && !splash.isDestroyed()) return;
  splash = new BrowserWindow({
    width: 360,
    height: 220,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    alwaysOnTop: true,
    title: 'Cursor Gateway Desktop',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset=\"utf-8\"><style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0} .card{width:280px;text-align:center} .t{font-size:18px;font-weight:600;margin-bottom:10px} .s{font-size:13px;opacity:.85;margin-bottom:14px} .bar{height:8px;background:#1f2937;border-radius:999px;overflow:hidden} .fill{height:100%;width:40%;background:linear-gradient(90deg,#22d3ee,#6366f1);border-radius:999px;animation:move 1.2s ease-in-out infinite} @keyframes move{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}</style></head><body><div class=\"card\"><div class=\"t\">Cursor Gateway Desktop</div><div class=\"s\">正在启动服务，请稍候…</div><div class=\"bar\"><div class=\"fill\"></div></div></div></body></html>`));
  splash.once('ready-to-show', () => { splash.show(); splash.focus(); });
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
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
  createSplash();

  ipcMain.handle('gateway:check', (_, p) => check(p || '/health'));
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
    closeSplash();
    openPanel();
    const t = tokenStatus();
    const guideDismissed = getGuideDismissed();
    if (!firstRunGuideShown && !guideDismissed && !t.ok) {
      firstRunGuideShown = true;
      openPanel();
      dialog.showMessageBox({
        type: 'info',
        title: '首次使用引导',
        message: '检测到尚未登录 Cursor',
        detail: '请按顺序操作：
1) 点击【Cursor 登录】
2) 点击【状态检测】确认 token 与 /health 正常'
      });
      setGuideDismissed(true);
    }
  }, 1400);
});

app.on('before-quit', () => {
  stopServer();
  if (loginProc) loginProc.kill('SIGTERM');
  closeSplash();
});
