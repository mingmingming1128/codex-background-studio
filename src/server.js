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
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });

const defaults = {
  image: '', imageName: '', dim: 0, blur: 0, surfaceOpacity: 0.78,
  popupBlur: 20, position: 'center', size: 'cover'
};
let config = loadConfig();
let desiredEnabled = false;
const sessions = new Map();

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
  try { await debugJson('/json/version'); desiredEnabled = true; await syncTargets(); return { ok: true, reused: true }; }
  catch { /* not launched with our debug port */ }
  if (await hasCodexProcess()) {
    throw new Error('Codex 已在运行。请先完全退出 Codex，再点击此按钮；这样才能以可注入背景的方式重新启动。');
  }
  const exe = await findCodexExe();
  const child = spawn(exe, [`--remote-debugging-address=${HOST}`, `--remote-debugging-port=${DEBUG_PORT}`], {
    detached: true, stdio: 'ignore', windowsHide: false
  });
  child.unref(); desiredEnabled = true;
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

function connectTarget(target) {
  if (!target.webSocketDebuggerUrl || sessions.has(target.id)) return;
  const ws = new WebSocket(target.webSocketDebuggerUrl); let seq = 0;
  const send = expression => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ id: ++seq, method: 'Runtime.evaluate', params: { expression, awaitPromise: false } }));
  ws.addEventListener('open', () => {
    sessions.set(target.id, { ws, send });
    send(desiredEnabled ? injectionSource(config) : removalSource());
  });
  ws.addEventListener('close', () => sessions.delete(target.id));
  ws.addEventListener('error', () => sessions.delete(target.id));
}

async function syncTargets() {
  try {
    const targets = await debugJson();
    targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl).forEach(connectTarget);
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
    if (url.pathname === '/api/restore' && req.method === 'POST') {
      desiredEnabled = false; broadcast(removalSource()); return json(res, 200, { ok: true });
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
