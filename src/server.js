'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const HOST = '127.0.0.1';
const UI_PORT = 47831;
const DEBUG_PORT = 47832;
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(process.env.APPDATA || os.homedir(), 'CodexBackgroundStudio');
const CONFIG_FILE = path.join(DATA, 'config.json');
const BACKGROUND_LAUNCHER = path.join(ROOT, 'launch-codex-background.vbs');
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });

const defaults = {
  image: '', imageName: '', dim: 0, blur: 0, surfaceOpacity: 0.78,
  popupBlur: 20, position: 'center', size: 'cover', enabled: false
};
let config = loadConfig();
let desiredEnabled = Boolean(config.enabled);
const sessions = new Map();
const clearedTargets = new Set();

function loadConfig() {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...defaults }; }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES * 1.45) { reject(new Error('图片过大，请选择 16 MB 以内的图片。')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function ps(script) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())));
}

async function findCodexExe() {
  const script = "$p=Get-AppxPackage -Name 'OpenAI.Codex'|Sort-Object Version -Descending|Select-Object -First 1; if($p){Join-Path $p.InstallLocation 'app\\ChatGPT.exe'}";
  const exe = await ps(script);
  if (!exe || !fs.existsSync(exe)) throw new Error('没有找到 Windows 版 Codex。请先从 Microsoft Store 安装。');
  return exe;
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createBackgroundShortcut() {
  const exe = await findCodexExe();
  if (!fs.existsSync(BACKGROUND_LAUNCHER)) throw new Error('背景模式启动器文件缺失，请重新下载完整程序。');
  const script = [
    '$shell=New-Object -ComObject WScript.Shell',
    '$desktop=[Environment]::GetFolderPath(\'Desktop\')',
    '$link=$shell.CreateShortcut((Join-Path $desktop \'Codex（背景模式）.lnk\'))',
    `$link.TargetPath=${psLiteral(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'))}`,
    `$link.Arguments=${psLiteral(`"${BACKGROUND_LAUNCHER}"`)}`,
    `$link.WorkingDirectory=${psLiteral(ROOT)}`,
    `$link.IconLocation=${psLiteral(`${exe},0`)}`,
    "$link.Description='通过 Codex Background Studio 启动并应用背景'",
    '$link.Save()',
    'Write-Output (Join-Path $desktop \'Codex（背景模式）.lnk\')'
  ].join('; ');
  const shortcut = await ps(script);
  return { ok: true, shortcut };
}

async function hasCodexProcess() {
  try { return (await ps("@(Get-Process ChatGPT -ErrorAction SilentlyContinue).Count")).trim() !== '0'; }
  catch { return false; }
}

function debugJson(route = '/json/list') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: DEBUG_PORT, path: route, timeout: 800 }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('调试接口返回异常')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

async function launchCodex() {
  try {
    await debugJson('/json/version');
    desiredEnabled = true; config.enabled = true; saveConfig();
    await syncTargets(); broadcast(injectionSource(config));
    return { ok: true, reused: true };
  }
  catch { /* not launched with our debug port */ }
  if (await hasCodexProcess()) {
    throw new Error('Codex 已在运行。请先完全退出 Codex，再点击此按钮；这样才能以可注入背景的方式重新启动。');
  }
  const exe = await findCodexExe();
  const child = spawn(exe, [`--remote-debugging-address=${HOST}`, `--remote-debugging-port=${DEBUG_PORT}`], {
    detached: true, stdio: 'ignore', windowsHide: false
  });
  child.unref(); desiredEnabled = true; config.enabled = true; saveConfig();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 400));
    try { await debugJson('/json/version'); await syncTargets(); return { ok: true, reused: false }; } catch { /* retry */ }
  }
  throw new Error('Codex 已启动，但调试接口未就绪。当前版本可能不接受远程调试参数。');
}

function injectionSource(cfg) {
  const safe = JSON.stringify(cfg).replaceAll('<', '\\u003c');
  return `(() => {
    const cfg = ${safe};
    const KEY = '__codexBackgroundStudio';
    if (window[KEY]) window[KEY].destroy();
    const touched = new Map();
    const style = document.createElement('style');
    style.id = 'codex-background-studio';
    style.textContent = \`
      html, body { background: transparent !important; }
      body::before { content:""; position:fixed; inset:0; z-index:-2147483647; pointer-events:none;
        background-image:linear-gradient(rgba(0,0,0,\${cfg.dim}),rgba(0,0,0,\${cfg.dim})),url("\${cfg.image}");
        background-size:\${cfg.size}; background-position:\${cfg.position}; background-repeat:no-repeat;
        filter:blur(\${cfg.blur}px); transform:scale(1.03); }
      [class*="_MainContentTopFade_"] { background-image:none !important; }
      .pointer-events-none.absolute.inset-x-0.bottom-0.bg-gradient-to-t.from-surface.via-surface {
        background-image:none !important;
      }
    \`;
    (document.head || document.documentElement).appendChild(style);
    function tint() {
      const area = innerWidth * innerHeight;
      document.querySelectorAll('body *').forEach(el => {
        if (el.id === style.id || el.closest('#codex-background-studio')) return;
        const r = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const remember = () => {
          if (!touched.has(el)) touched.set(el, {
            color: el.style.getPropertyValue('background-color'),
            image: el.style.getPropertyValue('background-image')
          });
        };

        // Only expose the wallpaper through large, normal-flow page shells.
        // Portals, menus, dialogs and other positioned UI keep native styling.
        let inOverlay = false;
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          const pos = getComputedStyle(p).position;
          if (pos === 'fixed' || pos === 'absolute') { inOverlay = true; break; }
        }
        if (!inOverlay && r.width * r.height > area * .45 &&
            computed.backgroundColor !== 'rgba(0, 0, 0, 0)' && computed.backgroundColor !== 'transparent') {
          remember();
          el.style.setProperty('background-color', 'transparent', 'important');
        }
      });
    }
    const observer = new MutationObserver(() => tint());
    observer.observe(document.documentElement, {childList:true, subtree:true});
    tint();
    window[KEY] = { destroy() { observer.disconnect(); style.remove(); touched.forEach((v,el) => {
      v.color ? el.style.setProperty('background-color',v.color) : el.style.removeProperty('background-color');
      v.image ? el.style.setProperty('background-image',v.image) : el.style.removeProperty('background-image');
    }); delete window[KEY]; } };
    return true;
  })()`;
}

function removalSource() {
  return `(() => { const x=window.__codexBackgroundStudio; if(x)x.destroy(); document.getElementById('codex-background-studio')?.remove(); return true; })()`;
}

function isBackgroundTarget(target) {
  if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  try {
    const url = new URL(target.url);
    if (url.protocol !== 'app:' || url.hostname !== '-') return false;
    if (url.pathname === '/detached-window.html') return true;
    if (url.pathname !== '/index.html') return false;
    return url.searchParams.get('initialRoute') !== '/avatar-overlay';
  } catch { return false; }
}

function clearExcludedTarget(target) {
  if (!target.webSocketDebuggerUrl || clearedTargets.has(target.id)) return;
  clearedTargets.add(target.id);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: removalSource(), awaitPromise: false } }));
    setTimeout(() => ws.close(), 100);
  });
  ws.addEventListener('error', () => clearedTargets.delete(target.id));
}

function connectTarget(target) {
  if (!target.webSocketDebuggerUrl || sessions.has(target.id)) return;
  const ws = new WebSocket(target.webSocketDebuggerUrl); let seq = 0;
  const send = expression => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ id: ++seq, method: 'Runtime.evaluate', params: { expression, awaitPromise: false } }));
  ws.addEventListener('open', () => {
    sessions.set(target.id, { ws, send });
    send(desiredEnabled ? injectionSource(config) : removalSource());
  });
  ws.addEventListener('close', () => { if (sessions.get(target.id)?.ws === ws) sessions.delete(target.id); });
  ws.addEventListener('error', () => { if (sessions.get(target.id)?.ws === ws) sessions.delete(target.id); });
}

async function syncTargets() {
  try {
    const targets = await debugJson();
    const liveIds = new Set(targets.map(target => target.id));
    for (const target of targets) {
      if (isBackgroundTarget(target)) {
        clearedTargets.delete(target.id);
        connectTarget(target);
      } else if (target.type === 'page' && target.webSocketDebuggerUrl) {
        const session = sessions.get(target.id);
        if (session) {
          session.send(removalSource());
          session.ws.close();
          sessions.delete(target.id);
        }
        clearExcludedTarget(target);
      }
    }
    for (const id of clearedTargets) if (!liveIds.has(id)) clearedTargets.delete(id);
    return targets.length;
  } catch { return 0; }
}

function broadcast(source) {
  for (const { send } of sessions.values()) send(source);
}

async function status() {
  let debug = false; try { await debugJson('/json/version'); debug = true; } catch {}
  return { running: await hasCodexProcess(), connected: debug, enabled: desiredEnabled, imageName: config.imageName, sessions: sessions.size };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${UI_PORT}`);
    if (url.pathname === '/api/status') return json(res, 200, await status());
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { ...config, image: config.image ? 'stored' : '' });
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const next = JSON.parse(await readBody(req));
      if (next.image && !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(next.image)) throw new Error('仅支持 PNG、JPG、WebP 或 GIF 图片。');
      config = { ...config, ...next };
      config.dim = Math.min(.9, Math.max(0, Number(config.dim)));
      config.blur = Math.min(30, Math.max(0, Number(config.blur)));
      config.popupBlur = Math.min(40, Math.max(0, Number(config.popupBlur)));
      config.surfaceOpacity = Math.min(1, Math.max(.25, Number(config.surfaceOpacity)));
      saveConfig();
      if (desiredEnabled) broadcast(injectionSource(config));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/start' && req.method === 'POST') return json(res, 200, await launchCodex());
    if (url.pathname === '/api/create-shortcut' && req.method === 'POST') return json(res, 200, await createBackgroundShortcut());
    if (url.pathname === '/api/resume' && req.method === 'POST') {
      if (!config.image) throw new Error('尚未保存背景图片，请先打开控制面板选择图片。');
      return json(res, 200, await launchCodex());
    }
    if (url.pathname === '/api/pause' && req.method === 'POST') {
      desiredEnabled = false; config.enabled = false; saveConfig(); broadcast(removalSource());
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/restore' && req.method === 'POST') {
      desiredEnabled = false; config.enabled = false; saveConfig(); broadcast(removalSource());
      return json(res, 200, { ok: true });
    }
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css' };
    res.writeHead(200, { 'content-type': types[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (error) { json(res, 400, { error: error.message || String(error) }); }
});

server.listen(UI_PORT, HOST, () => {
  console.log(`Codex Background Studio: http://${HOST}:${UI_PORT}`);
  if (!process.env.CODEX_BG_NO_BROWSER) {
    const opener = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', `http://${HOST}:${UI_PORT}`]] : ['xdg-open', [`http://${HOST}:${UI_PORT}`]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  }
});

setInterval(() => { if (desiredEnabled) syncTargets(); }, 1800).unref();
