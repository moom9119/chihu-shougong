/**
 * 极简静态服务器（零依赖，只用 node:http / node:fs）
 * 用途：ES Modules 无法从 file:// 直接加载，所以用一个本地 http 服务托管。
 *
 * 用法：
 *   node tools/serve.mjs                # 端口 7317，自动打开浏览器
 *   node tools/serve.mjs --port 8080
 *   node tools/serve.mjs --no-open      # 供截图 QA 使用
 *   node tools/serve.mjs --host 0.0.0.0 # 允许同局域网的其他设备访问（现场演示 / 手机预览）
 *
 * 注意：默认只监听 127.0.0.1（本机）。想让同一 Wi-Fi 下的手机/评委电脑打开，
 * 必须加 --host 0.0.0.0，并在 Windows 防火墙弹窗里允许；启动后会把局域网地址打出来。
 */
import http from 'node:http';
import os from 'node:os';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const START_PORT = Number(flag('port', process.env.PORT || 7317));
const NO_OPEN = hasFlag('no-open') || hasFlag('screenshot');
const HOST = flag('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

/* ----------------------------------------------------------------
   消息桥：给"重要联系人提醒"喂事件
     POST /api/interrupt  {"app":"wechat","contact":"张三"}
     GET  /api/interrupt?app=wechat&contact=张三      ← Tasker/curl 最省事
     GET  /api/interrupt?after=12                     ← 页面轮询
   浏览器拿不到微信/QQ/钉钉的消息，所以需要外部程序（手机端 Tasker、自建
   NotificationListenerService、或桌面脚本）往这里 POST。
------------------------------------------------------------------- */
const interrupts = [];
let interruptSeq = 0;

function sendJSON(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function pushInterrupt(app, contact) {
  const cleanApp = /^(wechat|qq|dingtalk)$/.test(String(app)) ? String(app) : 'wechat';
  const cleanName = String(contact ?? '').trim().slice(0, 24) || '某人';
  interruptSeq += 1;
  const evt = { id: interruptSeq, app: cleanApp, contact: cleanName, at: Date.now() };
  interrupts.push(evt);
  if (interrupts.length > 100) interrupts.shift();
  return evt;
}

async function handleInterruptApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    sendJSON(res, 204, {});
    return true;
  }
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    await new Promise((resolve) => {
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) return;
        chunks.push(c);
      });
      req.on('end', resolve);
      req.on('error', resolve);
    });
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      try {
        body = Object.fromEntries(new URLSearchParams(raw));
      } catch {
        body = {};
      }
    }
    const evt = pushInterrupt(body.app, body.contact);
    sendJSON(res, 200, { ok: true, event: evt });
    return true;
  }
  // GET：带 app/contact 就是"直接触发"，否则按游标取事件
  if (url.searchParams.has('app') || url.searchParams.has('contact')) {
    const evt = pushInterrupt(url.searchParams.get('app'), url.searchParams.get('contact'));
    sendJSON(res, 200, { ok: true, event: evt });
    return true;
  }
  if (url.searchParams.get('init') === '1') {
    // 页面刚打开：只对齐游标，不重放历史消息
    sendJSON(res, 200, { events: [], last: interruptSeq });
    return true;
  }
  const after = Number(url.searchParams.get('after') || 0);
  sendJSON(res, 200, { events: interrupts.filter((e) => e.id > after), last: interruptSeq });
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (reqUrl.pathname.startsWith('/api/interrupt')) {
      await handleInterruptApi(req, res, reqUrl);
      return;
    }
    let file = safeJoin(ROOT, req.url || '/');
    if (!file) {
      res.writeHead(403).end('403 forbidden');
      return;
    }
    let stat = await fs.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fs.stat(file).catch(() => null);
    }
    if (!stat) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found: ' + req.url);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

/** 本机的局域网 IPv4（给"现场演示 / 手机预览"用） */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) {
      if (nic.family !== 'IPv4' || nic.internal) continue;
      if (nic.address.startsWith('169.254.')) continue;
      out.push(nic.address);
    }
  }
  return out;
}

function listen(port, attemptsLeft = 12) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('[serve] 启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\n  赤狐收工 · 屏幕时间限制管理器`);
    console.log(`  → ${url}`);
    if (HOST === '0.0.0.0' || HOST === '::') {
      const lan = lanAddresses();
      if (lan.length) {
        console.log(`\n  同一 Wi-Fi 下的手机 / 其他电脑也能打开：`);
        for (const ip of lan) console.log(`  → http://${ip}:${port}/`);
        console.log(`  （Windows 防火墙弹窗要点「允许访问」；关掉这个窗口就失效）`);
      } else {
        console.log(`  （没找到局域网地址，可能没连 Wi-Fi）`);
      }
    } else {
      console.log(`  只监听本机。想给同 Wi-Fi 的手机看：加 --host 0.0.0.0`);
    }
    console.log(`\n  (Ctrl+C 停止)\n`);
    if (!NO_OPEN && process.platform === 'win32') {
      exec(`start "" "${url}"`);
    }
  });
}

listen(START_PORT);
