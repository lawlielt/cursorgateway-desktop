const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let tray;
let win;
let serverProc = null;
let loginProc = null;
let firstRunGuideShown = false;

const appRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(appRoot, 'src', 'app.js');
const loginEntry = path.join(appRoot, 'src', 'tool', 'cursorLogin.js');
const packagedLoginEntry = path.join(process.resourcesPath || '', 'app.asar', 'src', 'tool', 'cursorLogin.js');
let currentPort = process.env.PORT || '3010';
function getBaseURL(){ return `http://127.0.0.1:${currentPort}`; }
const tokenFile = path.join(appRoot, '.cursor-token');
const runtimeCwd = process.resourcesPath || process.cwd();
const runtimeTokenFile = path.join(app.getPath('userData'), '.cursor-token');
const legacyTokenFile = path.join(process.env.HOME || '', 'Library', 'Application Support', 'cursor-gateway', '.cursor-token');


process.on('uncaughtException', (err) => {
  try {
    const f = path.join(app.getPath('userData'), 'desktop-crash.log');
    fs.appendFileSync(f, `[${new Date().toISOString()}] uncaughtException: ${err?.stack || err}
`);
  } catch {}
  console.error('[desktop] uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  try {
    const f = path.join(app.getPath('userData'), 'desktop-crash.log');
    fs.appendFileSync(f, `[${new Date().toISOString()}] unhandledRejection: ${err?.stack || err}
`);
  } catch {}
  console.error('[desktop] unhandledRejection', err);
});


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


function getSavedPort() {
  try {
    const f = prefFilePath();
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.port ? String(j.port) : null;
  } catch {
    return null;
  }
}

function setSavedPort(v) {
  try {
    const f = prefFilePath();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let j = {};
    if (fs.existsSync(f)) {
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { j = {}; }
    }
    j.port = String(v);
    fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[prefs] write port failed:', e);
    return false;
  }
}

function tokenStatus() {
  try {
    const f = fs.existsSync(runtimeTokenFile) ? runtimeTokenFile : (fs.existsSync(legacyTokenFile) ? legacyTokenFile : tokenFile);
    if (!fs.existsSync(f)) return { ok: false, msg: '未检测到 .cursor-token，请先点击“Cursor 登录”。' };
    const t = fs.readFileSync(f, 'utf8').trim();
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
      PORT: String(currentPort),
      CURSOR_GATEWAY_SESSIONS_DIR: path.join(app.getPath('userData'), 'sessions'),
      CURSOR_GATEWAY_LOG_FILE: path.join(app.getPath('userData'), 'server.log'),
      CURSOR_GATEWAY_TOKEN_FILE: runtimeTokenFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}



function startServerEmbedded() {
  if (serverProc) return;
  process.env.PORT = String(currentPort);
  process.env.CURSOR_GATEWAY_SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions');
  process.env.CURSOR_GATEWAY_LOG_FILE = path.join(app.getPath('userData'), 'server.log');
  process.env.CURSOR_GATEWAY_TOKEN_FILE = runtimeTokenFile;
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
  const url = `${getBaseURL()}${pathname}`;
  try {
    const tokenPath = fs.existsSync(runtimeTokenFile) ? runtimeTokenFile : (fs.existsSync(legacyTokenFile) ? legacyTokenFile : null);
    const token = tokenPath ? fs.readFileSync(tokenPath, 'utf8').trim() : '';
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetch(url, { headers });
    const text = await r.text();
    return { ok: true, url, status: r.status, body: text };
  } catch (e) {
    return { ok: false, url, status: 0, body: String(e) };
  }
}




function writeClaudeCodeConfig() {
  try {
    const home = process.env.HOME || app.getPath('home');
    const claudeDir = path.join(home, '.claude');
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.json');
    let conf = {};
    if (fs.existsSync(settingsPath)) {
      try { conf = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { conf = {}; }
      const backup = path.join(claudeDir, `settings.backup.${Date.now()}.json`);
      fs.writeFileSync(backup, JSON.stringify(conf, null, 2), 'utf8');
    }

    conf.env = conf.env || {};
    // align with user's preferred Claude Code gateway config
    conf.env.ANTHROPIC_AUTH_TOKEN = conf.env.ANTHROPIC_AUTH_TOKEN || 'unused';
    conf.env.ANTHROPIC_BASE_URL = getBaseURL();
    conf.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6';
    conf.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = conf.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1';
    conf.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = conf.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '12000';

    // force opus by default for one-click import
    conf.model = 'opus';

    fs.writeFileSync(settingsPath, JSON.stringify(conf, null, 2), 'utf8');
    return { ok: true, path: settingsPath, baseURL: getBaseURL() };
  } catch (e) {
    return { ok: false, error: String(e) };
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
    { label: tokenStatus().ok ? '✅ Cursor 已登录' : 'Cursor 登录', click: runLoginFlow },
    { label: '一键导入 Claude Code 配置', click: async () => {
      const r = writeClaudeCodeConfig();
      dialog.showMessageBox({ message: r.ok ? `已写入: ${r.path}\nBaseURL: ${r.baseURL}` : `导入失败: ${r.error}` });
    } },
    { label: `当前端口: ${currentPort}`, enabled: false },
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
  const saved = getSavedPort();
  if (saved) currentPort = saved;
  ipcMain.handle('gateway:check', (_, p) => check(p || '/health'));
  ipcMain.handle('gateway:start', () => { startServer(); return { ok: true }; });
  ipcMain.handle('gateway:stop', () => { stopServer(); return { ok: true }; });
  ipcMain.handle('gateway:login', () => { runLoginFlow(); return { ok: true }; });
  ipcMain.handle('gateway:status', async () => {
    const t = tokenStatus();
    const h = await check('/health');
    return { token: t, health: h, port: currentPort, baseURL: getBaseURL() };
  });
  ipcMain.handle('gateway:get-config', async () => ({ port: currentPort, baseURL: getBaseURL() }));
  ipcMain.handle('gateway:import-claude', async () => writeClaudeCodeConfig());
  ipcMain.handle('gateway:set-port', async (_e, portVal) => {
    const p = String(portVal || '').trim();
    if (!/^\d{2,5}$/.test(p)) return { ok: false, error: '端口格式不正确' };
    const n = Number(p);
    if (n < 1 || n > 65535) return { ok: false, error: '端口范围应在 1-65535' };

    const wasRunning = !!serverProc;
    const wasEmbedded = !!(serverProc && serverProc.embedded);

    currentPort = p;
    setSavedPort(p);
    process.env.PORT = p;
    refreshMenu();

    if (wasRunning && !wasEmbedded) {
      stopServer();
      setTimeout(() => startServer(), 300);
      return { ok: true, port: currentPort, baseURL: getBaseURL(), restarted: true };
    }

    if (wasRunning && wasEmbedded) {
      // packaged embedded mode: relaunch app to apply new port reliably
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 200);
      return { ok: true, port: currentPort, baseURL: getBaseURL(), relaunched: true };
    }

    return { ok: true, port: currentPort, baseURL: getBaseURL() };
  });

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('CG');
  tray.setToolTip('Cursor Gateway Desktop');
  tray.on('click', openPanel);
  refreshMenu();
  startServer();
  openPanel();
  app.focus();

  setTimeout(() => {
    openPanel();
    const t = tokenStatus();
    const guideDismissed = getGuideDismissed();
    if (!firstRunGuideShown && !guideDismissed && !t.ok) {
      firstRunGuideShown = true;
      // panel already opened; keep non-blocking guide behavior
      setGuideDismissed(true);
    }
  }, 1400);
});

app.on('before-quit', () => {
  stopServer();
  if (loginProc) loginProc.kill('SIGTERM');
});
