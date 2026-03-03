import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, getPeerIdentities, getFullAddress, getTlsOptions, createIdentityVerifier } from './config.ts';
import { createLogger } from './util/logger.ts';
import { readBody } from './util/http.ts';
import type { ICCConfig } from './types.ts';

const log = createLogger('web');

interface ProxyTarget {
  baseUrl: string;
  token: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestFn: typeof httpRequest;
  requestOpts: Record<string, unknown>;
}

function resolveProxyTarget(config: ICCConfig, peerIdentity: string): ProxyTarget | null {
  const tlsOpts = getTlsOptions(config);
  if (peerIdentity === config.identity) {
    const protocol = tlsOpts ? 'https' : 'http';
    const baseUrl = `${protocol}://127.0.0.1:${config.server.port}`;
    const token = config.server.localToken || config.server.authToken || '';
    return {
      baseUrl,
      token,
      requestFn: tlsOpts ? httpsRequest : httpRequest,
      requestOpts: tlsOpts ? { ...tlsOpts, checkServerIdentity: createIdentityVerifier(config.identity) } : {},
    };
  }
  const peer = config.remotes?.[peerIdentity];
  if (!peer?.httpUrl) return null;
  const baseUrl = peer.httpUrl;
  const token = peer.token || config.server.authToken || '';
  const isHttps = baseUrl.startsWith('https://');
  return {
    baseUrl,
    token,
    requestFn: isHttps ? httpsRequest : httpRequest,
    requestOpts: isHttps && tlsOpts ? { ...tlsOpts, rejectUnauthorized: true, checkServerIdentity: createIdentityVerifier(peerIdentity) } : {},
  };
}

function proxyRequest(config: ICCConfig, peerIdentity: string, apiPath: string, incomingReq: IncomingMessage, outgoingRes: ServerResponse): void {
  const target = resolveProxyTarget(config, peerIdentity);
  if (!target) {
    outgoingRes.writeHead(404, { 'Content-Type': 'application/json' });
    outgoingRes.end(JSON.stringify({ error: `Unknown peer: ${peerIdentity}` }));
    return;
  }

  const targetUrl = new URL(apiPath, target.baseUrl);
  const headers: Record<string, string> = { 'Authorization': `Bearer ${target.token}` };
  if (incomingReq.headers['content-type']) {
    headers['Content-Type'] = incomingReq.headers['content-type'];
  }

  const proxyReq = target.requestFn(targetUrl, {
    method: incomingReq.method,
    headers,
    ...target.requestOpts,
  }, (proxyRes) => {
    outgoingRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(outgoingRes);
    outgoingRes.on('close', () => proxyRes.destroy());
  });

  proxyReq.on('error', (err) => {
    log.warn(`Proxy to ${peerIdentity} failed: ${err.message}`);
    if (!outgoingRes.headersSent) {
      outgoingRes.writeHead(502, { 'Content-Type': 'application/json' });
      outgoingRes.end(JSON.stringify({ error: `Upstream unreachable: ${err.message}` }));
    } else {
      outgoingRes.end();
    }
  });

  if (incomingReq.method === 'POST' || incomingReq.method === 'PUT') {
    incomingReq.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function getHTML(config: ICCConfig): string {
  const localIdentity = config.identity;
  const peers = getPeerIdentities(config);

  // Build hosts array with proxy URLs — no auth tokens exposed to browser
  const hosts = [
    { identity: localIdentity, url: `/proxy/${localIdentity}`, isLocal: true },
    ...peers.map(p => ({
      identity: p,
      url: `/proxy/${p}`,
      isLocal: false,
    })),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICC — Inter-Claude Connector</title>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --orange: #d29922;
    --inbox-accent: #a371f7; --inbox-unread-bg: #2a2040;
    --content-max: 840px;
    --content-pad: max(20px, calc(50vw - var(--content-max) / 2));
  }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; }

  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 16px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; flex-shrink: 0; }
  header h1 { font-size: 14px; font-weight: 600; color: var(--accent); }
  .header-left { display: flex; align-items: center; }
  .header-right { display: flex; justify-content: flex-end; }
  .status-bar { display: flex; gap: 20px; font-size: 12px; align-items: center; flex-wrap: wrap; }
  .status-item { display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.ok { background: var(--green); }
  .dot.err { background: var(--red); }
  .dot.pending { background: var(--orange); }

  #chat { flex: 1; overflow-y: auto; padding: 24px var(--content-pad); display: flex; flex-direction: column; gap: 14px; }
  #chat::-webkit-scrollbar { width: 6px; }
  #chat::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .message { max-width: min(82%, var(--content-max)); padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.6; position: relative; border: 1px solid var(--sender-color, var(--border)); background: var(--sender-bg, var(--surface)); }
  .message { align-self: flex-start; }
  .message .meta { font-size: 11px; color: var(--muted); margin-bottom: 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .message .meta .identity { font-weight: 600; color: var(--sender-color, var(--accent)); }
  .message .meta .recipient { color: var(--muted); }
  .message .meta .recipient .addr { color: var(--text); font-weight: 500; }
  .message .meta .badge { background: var(--border); padding: 1px 5px; border-radius: 3px; font-size: 10px; }
  .message .body { white-space: pre-wrap; word-break: break-word; }
  .message .reply-link { font-size: 10px; color: var(--muted); margin-top: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
  .message .reply-link:hover { color: var(--accent); }
  .message.inbox { border-left: 3px solid var(--sender-color, var(--inbox-accent)); }
  .message.inbox.unread { background: var(--inbox-unread-bg); }
  .badge.inbox-badge { background: var(--inbox-accent); color: #fff; }
  .badge.unread-badge { background: var(--orange); color: #fff; }
  .inbox-actions { display: flex; gap: 12px; margin-top: 8px; }
  .inbox-actions button { background: none; border: none; color: var(--muted); font-family: inherit; font-size: 11px; cursor: pointer; padding: 0; }
  .inbox-actions button:hover { color: var(--accent); }
  .refresh-btn { background: none; border: 1px solid var(--border); color: var(--muted); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 14px; font-family: inherit; }
  .refresh-btn:hover { color: var(--text); border-color: var(--accent); }
  .unread-count { color: var(--orange); font-weight: 600; margin-left: 4px; font-size: 12px; }

  .scroll-btn { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); right: auto; background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 6px 16px; border-radius: 16px; cursor: pointer; font-size: 12px; display: none; z-index: 10; }
  .scroll-btn:hover { color: var(--text); border-color: var(--accent); }

  .input-bar { background: var(--surface); border-top: 1px solid var(--border); padding: 12px var(--content-pad); display: flex; gap: 10px; flex-shrink: 0; align-items: flex-end; }
  .input-bar textarea { flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 8px; font-family: inherit; font-size: 13px; resize: none; outline: none; min-height: 40px; max-height: 120px; }
  .input-bar textarea:focus { border-color: var(--accent); }
  .input-bar select { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 8px; border-radius: 8px; font-family: inherit; font-size: 13px; outline: none; cursor: pointer; }
  .input-bar select:focus { border-color: var(--accent); }
  .input-bar button { background: var(--accent); color: var(--bg); border: none; padding: 10px 20px; border-radius: 8px; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .input-bar button:hover { opacity: 0.9; }
  .input-bar button:disabled { opacity: 0.4; cursor: not-allowed; }

  .empty-state { color: var(--muted); text-align: center; margin-top: 40vh; font-size: 14px; }

  .md-toggle { background: none; border: none; color: var(--muted); font-family: inherit; font-size: 11px; cursor: pointer; padding: 0; margin-left: auto; }
  .md-toggle:hover { color: var(--accent); }

  .body.md-rendered { white-space: normal; }
  .body.md-rendered h1, .body.md-rendered h2, .body.md-rendered h3 { margin: 8px 0 4px; font-size: 14px; font-weight: 600; color: var(--accent); }
  .body.md-rendered h1 { font-size: 16px; }
  .body.md-rendered h2 { font-size: 15px; }
  .body.md-rendered p { margin: 4px 0; }
  .body.md-rendered ul, .body.md-rendered ol { margin: 4px 0 4px 20px; }
  .body.md-rendered li { margin: 2px 0; }
  .body.md-rendered code { background: rgba(110,118,129,0.2); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .body.md-rendered pre { background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0; }
  .body.md-rendered pre code { background: none; padding: 0; }
  .body.md-rendered blockquote { border-left: 3px solid var(--border); padding-left: 10px; color: var(--muted); margin: 6px 0; }
  .body.md-rendered a { color: var(--accent); text-decoration: none; }
  .body.md-rendered a:hover { text-decoration: underline; }
  .body.md-rendered hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
  .body.md-rendered table { border-collapse: collapse; margin: 6px 0; }
  .body.md-rendered th, .body.md-rendered td { border: 1px solid var(--border); padding: 4px 8px; font-size: 12px; }
  .body.md-rendered th { background: rgba(110,118,129,0.15); }

  .hamburger { background: none; border: none; color: var(--text); font-size: 20px; cursor: pointer; padding: 4px 8px; margin-right: 8px; line-height: 1; }
  .hamburger:hover { color: var(--accent); }

  .sidebar-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
  .sidebar-overlay.open { opacity: 1; pointer-events: auto; }

  .sidebar { position: fixed; top: 0; left: 0; bottom: 0; width: 240px; background: var(--surface); border-right: 1px solid var(--border); z-index: 101; transform: translateX(-100%); transition: transform 0.2s; display: flex; flex-direction: column; }
  .sidebar.open { transform: translateX(0); }
  .sidebar-header { padding: 16px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600; color: var(--accent); }
  .sidebar-nav { flex: 1; padding: 8px 0; }
  .sidebar-item { display: flex; align-items: center; gap: 10px; padding: 10px 16px; font-size: 13px; color: var(--muted); cursor: pointer; border: none; background: none; width: 100%; text-align: left; font-family: inherit; }
  .sidebar-item:hover { background: rgba(255,255,255,0.05); color: var(--text); }
  .sidebar-item.active { color: var(--accent); background: rgba(88,166,255,0.1); border-right: 2px solid var(--accent); }
  .sidebar-item .icon { font-size: 16px; width: 20px; text-align: center; }

  .view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .view:not(.active) { display: none !important; }

  .host-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .host-card-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .host-card-header:hover { background: rgba(255,255,255,0.03); }
  .host-card-header .chevron { color: var(--muted); font-size: 11px; margin-left: auto; transition: transform 0.2s; }
  .host-card-header .chevron.collapsed { transform: rotate(-90deg); }
  .host-card-body { padding: 0 14px 14px; }
  .host-card-body.collapsed { display: none; }
  .instance-section { margin-top: 10px; }
  .instance-section-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .instance-row { padding: 6px 0; border-bottom: 1px solid rgba(48,54,61,0.5); font-size: 12px; }
  .instance-row:last-child { border-bottom: none; }
  .instance-name { font-weight: 600; color: var(--text); }
  .instance-path { color: var(--muted); margin-left: 8px; }
  .instance-meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .instance-row.inactive .instance-name { color: var(--muted); }
  .host-card-error { padding: 10px 14px; font-size: 12px; color: var(--red); }
</style>
</head>
<body>
<div class="sidebar-overlay" id="sidebar-overlay"></div>
<div class="sidebar" id="sidebar">
  <div class="sidebar-header">ICC</div>
  <nav class="sidebar-nav">
    <button class="sidebar-item active" data-view="conversation"><span class="icon">&#9993;</span> Conversation</button>
    <button class="sidebar-item" data-view="instances"><span class="icon">&#9673;</span> Instances</button>
  </nav>
</div>

<header>
  <div class="header-left">
    <button class="hamburger" id="hamburger-btn">&#9776;</button>
    <h1>ICC — Inter-Claude Connector</h1>
  </div>
  <div class="status-bar" id="status-bar"></div>
  <div class="header-right">
    <button class="refresh-btn" id="refresh-btn" title="Refresh inbox">&#x21bb;</button>
  </div>
</header>

<div id="view-conversation" class="view active">
<div id="chat"><div class="empty-state">No messages yet.</div></div>
<button class="scroll-btn" id="scroll-btn">&#8595; New messages</button>

<div class="input-bar">
  <textarea id="input" placeholder="Send a message..." rows="1"></textarea>
  <select id="addr-select"><option value="">Loading...</option></select>
  <button id="send-btn">Send</button>
</div>
</div>

<div id="view-instances" class="view">
  <div style="padding: 24px var(--content-pad); flex:1; overflow-y:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="font-size:15px;font-weight:600;color:var(--accent);">Instances</h2>
      <button class="refresh-btn" id="instances-refresh-btn" title="Refresh instances">&#x21bb;</button>
    </div>
    <div id="instances-container"><div class="empty-state" style="margin-top:20vh;">Loading instances...</div></div>
  </div>
</div>

<script>
var HOSTS = ${JSON.stringify(hosts)};
var LOCAL_IDENTITY = ${JSON.stringify(localIdentity)};

var chat = document.getElementById('chat');
var input = document.getElementById('input');
var sendBtn = document.getElementById('send-btn');
var scrollBtn = document.getElementById('scroll-btn');
var addrSelect = document.getElementById('addr-select');
var autoScroll = true;
var initialLoadDone = false;
var seenInboxIds = new Set();
var seenMulticastKeys = new Set();
var inboxPollTimer = null;
var INBOX_POLL_INTERVAL = 30000;
var latestInboxTimestamp = null;
var inboxInitialLoadDone = false;

var hamburgerBtn = document.getElementById('hamburger-btn');
var sidebar = document.getElementById('sidebar');
var sidebarOverlay = document.getElementById('sidebar-overlay');

hamburgerBtn.addEventListener('click', function() {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('open');
});
sidebarOverlay.addEventListener('click', function() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('open');
});

var currentView = 'conversation';

document.querySelectorAll('.sidebar-item').forEach(function(item) {
  item.addEventListener('click', function() {
    var view = this.dataset.view;
    if (view === currentView) {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.remove('open');
      return;
    }
    currentView = view;
    document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
    this.classList.add('active');
    document.querySelectorAll('.view').forEach(function(el) { el.classList.remove('active'); });
    document.getElementById('view-' + view).classList.add('active');
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
    if (view === 'instances') {
      refreshInstances();
      startInstancesPoll();
    } else {
      if (instancesPollTimer) { clearInterval(instancesPollTimer); instancesPollTimer = null; }
    }
  });
});

var instancesPollTimer = null;
var INSTANCES_POLL_INTERVAL = 10000;

async function fetchHostInstances(host) {
  var results = await Promise.all([
    fetch(host.url + '/api/registry').then(function(r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); }),
    fetch(host.url + '/api/instances').then(function(r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); }),
  ]);
  return { registry: results[0].instances || [], index: results[1].instances || [] };
}

function renderHostCard(host, data) {
  var card = document.createElement('div');
  card.className = 'host-card';

  var header = document.createElement('div');
  header.className = 'host-card-header';
  var dot = document.createElement('span');
  dot.className = 'dot ' + (data.error ? 'err' : 'ok');
  header.appendChild(dot);
  var title = document.createElement('span');
  title.textContent = host.identity;
  header.appendChild(title);
  if (data.registry) {
    var count = document.createElement('span');
    count.style.cssText = 'color:var(--muted);font-weight:400;font-size:12px;';
    count.textContent = ' (' + data.registry.length + ' active)';
    header.appendChild(count);
  }
  var chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = '\u25BC';
  header.appendChild(chevron);
  card.appendChild(header);

  var body = document.createElement('div');
  body.className = 'host-card-body';

  if (data.error) {
    var errDiv = document.createElement('div');
    errDiv.className = 'host-card-error';
    errDiv.textContent = data.error;
    body.appendChild(errDiv);
  } else {
    var activeNames = new Set(data.registry.map(function(r) { return r.instance; }));
    var indexByName = {};
    data.index.forEach(function(i) { indexByName[i.name] = i; });

    // Active section
    if (data.registry.length > 0) {
      var activeSection = document.createElement('div');
      activeSection.className = 'instance-section';
      var activeTitle = document.createElement('div');
      activeTitle.className = 'instance-section-title';
      activeTitle.textContent = 'Active (' + data.registry.length + ')';
      activeSection.appendChild(activeTitle);
      data.registry.forEach(function(inst) {
        var row = document.createElement('div');
        row.className = 'instance-row';
        var nameSpan = document.createElement('span');
        nameSpan.className = 'instance-name';
        nameSpan.textContent = inst.instance;
        row.appendChild(nameSpan);
        var pathInfo = indexByName[inst.instance];
        if (pathInfo) {
          var pathSpan = document.createElement('span');
          pathSpan.className = 'instance-path';
          pathSpan.textContent = pathInfo.path;
          row.appendChild(pathSpan);
        }
        var meta = document.createElement('div');
        meta.className = 'instance-meta';
        var parts = ['PID ' + inst.pid];
        if (inst.registeredAt) parts.push('since ' + formatTime(inst.registeredAt));
        meta.textContent = parts.join(' \u00B7 ');
        row.appendChild(meta);
        activeSection.appendChild(row);
      });
      body.appendChild(activeSection);
    }

    // Inactive section
    var inactive = data.index.filter(function(i) { return !activeNames.has(i.name); });
    if (inactive.length > 0) {
      var inactiveSection = document.createElement('div');
      inactiveSection.className = 'instance-section';
      var inactiveTitle = document.createElement('div');
      inactiveTitle.className = 'instance-section-title';
      inactiveTitle.textContent = 'Inactive (' + inactive.length + ')';
      inactiveSection.appendChild(inactiveTitle);
      inactive.forEach(function(inst) {
        var row = document.createElement('div');
        row.className = 'instance-row inactive';
        var nameSpan = document.createElement('span');
        nameSpan.className = 'instance-name';
        nameSpan.textContent = inst.name;
        row.appendChild(nameSpan);
        var pathSpan = document.createElement('span');
        pathSpan.className = 'instance-path';
        pathSpan.textContent = inst.path;
        row.appendChild(pathSpan);
        inactiveSection.appendChild(row);
      });
      body.appendChild(inactiveSection);
    }

    if (data.registry.length === 0 && inactive.length === 0) {
      var emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'color:var(--muted);font-size:12px;padding:10px 0;';
      emptyDiv.textContent = 'No instances found.';
      body.appendChild(emptyDiv);
    }
  }

  card.appendChild(body);

  header.addEventListener('click', function() {
    body.classList.toggle('collapsed');
    chevron.classList.toggle('collapsed');
  });

  return card;
}

async function refreshInstances() {
  var container = document.getElementById('instances-container');
  var results = [];
  for (var i = 0; i < HOSTS.length; i++) {
    try {
      var data = await fetchHostInstances(HOSTS[i]);
      results.push({ host: HOSTS[i], data: data });
    } catch (err) {
      results.push({ host: HOSTS[i], data: { error: err.message || 'Unreachable' } });
    }
  }
  while (container.firstChild) container.removeChild(container.firstChild);
  if (results.length === 0) {
    var emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.style.marginTop = '20vh';
    emptyState.textContent = 'No hosts configured.';
    container.appendChild(emptyState);
    return;
  }
  results.forEach(function(r) {
    container.appendChild(renderHostCard(r.host, r.data));
  });
}

function startInstancesPoll() {
  if (instancesPollTimer) clearInterval(instancesPollTimer);
  instancesPollTimer = setInterval(function() {
    if (currentView === 'instances') refreshInstances();
  }, INSTANCES_POLL_INTERVAL);
}

document.getElementById('instances-refresh-btn').addEventListener('click', refreshInstances);

// Build status bar dynamically
(function() {
  var bar = document.getElementById('status-bar');
  HOSTS.forEach(function(h, i) {
    var item = document.createElement('div');
    item.className = 'status-item';
    var dot = document.createElement('span');
    dot.className = 'dot pending';
    dot.id = 'dot-' + i;
    var lbl = document.createElement('span');
    lbl.id = 'lbl-' + i;
    lbl.textContent = h.identity;
    var unread = document.createElement('span');
    unread.className = 'unread-count';
    unread.id = 'unread-' + i;
    item.appendChild(dot);
    item.appendChild(lbl);
    item.appendChild(unread);
    bar.appendChild(item);
  });
})();

input.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});
input.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInboxMessage(); }
});
scrollBtn.addEventListener('click', scrollToBottom);
sendBtn.addEventListener('click', sendInboxMessage);
document.getElementById('refresh-btn').addEventListener('click', function() {
  if (inboxPollTimer) clearInterval(inboxPollTimer);
  refreshInbox();
  startInboxPoll();
});

chat.addEventListener('scroll', function() {
  var atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  autoScroll = atBottom;
  scrollBtn.style.display = atBottom ? 'none' : 'block';
});

function scrollToBottom(instant) {
  chat.scrollTo({ top: chat.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  autoScroll = true;
  scrollBtn.style.display = 'none';
}

function formatTime(ts) {
  var d = new Date(ts);
  var date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  return date + ', ' + time;
}

function createBadge(text) {
  var span = document.createElement('span');
  span.className = 'badge';
  span.textContent = text;
  return span;
}

function createReplyLink(replyToId) {
  var link = document.createElement('a');
  link.className = 'reply-link';
  link.textContent = 'reply to ' + replyToId.slice(0, 8) + '...';
  link.href = '#';
  link.onclick = function(e) {
    e.preventDefault();
    var target = document.querySelector('[data-inbox-id="' + replyToId + '"]');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.style.outline = '1px solid var(--accent)';
      setTimeout(function() { target.style.outline = ''; }, 2000);
    }
  };
  return link;
}

function renderMarkdown(text) {
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    try {
      // Safe: output is sanitized via DOMPurify.sanitize()
      var raw = marked.parse(text, { breaks: true });
      return DOMPurify.sanitize(raw);
    } catch (e) {}
  }
  return null;
}

function setMarkdownBody(bodyEl, rawText) {
  var html = renderMarkdown(rawText);
  if (html) {
    // Safe: html is sanitized via DOMPurify.sanitize() in renderMarkdown()
    bodyEl.innerHTML = html;
    bodyEl.classList.add('md-rendered');
    bodyEl.dataset.mode = 'md';
  } else {
    bodyEl.textContent = rawText;
    bodyEl.dataset.mode = 'raw';
  }
  bodyEl.dataset.raw = rawText;
}

function createMarkdownToggle(bodyEl) {
  var btn = document.createElement('button');
  btn.className = 'md-toggle';
  btn.textContent = '</>';
  btn.title = 'Toggle raw / formatted';
  btn.onclick = function() {
    if (bodyEl.dataset.mode === 'md') {
      bodyEl.textContent = bodyEl.dataset.raw;
      bodyEl.classList.remove('md-rendered');
      bodyEl.dataset.mode = 'raw';
    } else {
      var html = renderMarkdown(bodyEl.dataset.raw);
      if (html) {
        // Safe: html is sanitized via DOMPurify.sanitize() in renderMarkdown()
        bodyEl.innerHTML = html;
        bodyEl.classList.add('md-rendered');
        bodyEl.dataset.mode = 'md';
      }
    }
  };
  return btn;
}

var SENDER_PALETTE = [
  '#58a6ff', '#3fb950', '#d2a8ff', '#f0883e', '#f778ba',
  '#79c0ff', '#7ee787', '#ffa657', '#ff7b72', '#a5d6ff',
];

function senderColor(name) {
  var hash = 0;
  for (var i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return SENDER_PALETTE[Math.abs(hash) % SENDER_PALETTE.length];
}

function hexToRgba(hex, alpha) {
  var r = parseInt(hex.slice(1, 3), 16);
  var g = parseInt(hex.slice(3, 5), 16);
  var b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function applySenderStyle(el, from) {
  var color = senderColor(from);
  el.style.setProperty('--sender-color', color);
  el.style.setProperty('--sender-bg', hexToRgba(color, 0.08));
}

function connectSSE(host, idx) {
  var dot = document.getElementById('dot-' + idx);
  var lbl = document.getElementById('lbl-' + idx);

  function connect() {
    var es = new EventSource(host.url + '/api/events');
    es.onopen = function() {
      dot.className = 'dot ok';
      lbl.textContent = host.identity + ' connected';
    };
    es.onmessage = function(e) {
      try { addInboxMessage(JSON.parse(e.data), host.url); } catch {}
    };
    es.onerror = function() {
      dot.className = 'dot err';
      lbl.textContent = host.identity + ' disconnected';
      es.close();
      setTimeout(connect, 5000);
    };
  }
  connect();
}

async function checkHealth(host, idx) {
  try {
    var res = await fetch(host.url + '/api/health');
    if (!res.ok) throw new Error();
    var data = await res.json();
    document.getElementById('dot-' + idx).className = 'dot ok';
    document.getElementById('lbl-' + idx).textContent = data.identity;
    return data.identity;
  } catch {
    document.getElementById('dot-' + idx).className = 'dot err';
    document.getElementById('lbl-' + idx).textContent = host.identity + ' offline';
    return host.identity;
  }
}

async function sendInboxMessage() {
  var text = input.value.trim();
  if (!text) return;
  var to = addrSelect ? addrSelect.value : '';
  if (!to) { console.error('No address selected'); return; }
  sendBtn.disabled = true;
  input.value = '';
  input.style.height = 'auto';

  try {
    var res = await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, to: to }),
    });
    var data = await res.json();
    if (data.error) console.error('Send error:', data.error);
  } catch (err) {
    console.error('Send failed:', err);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

function addInboxMessage(msg, serverUrl) {
  if (!latestInboxTimestamp || msg.timestamp > latestInboxTimestamp) {
    latestInboxTimestamp = msg.timestamp;
  }
  if (seenInboxIds.has(msg.id)) {
    var existing = document.querySelector('[data-inbox-id="' + msg.id + '"]');
    if (existing) {
      if (msg.read && existing.classList.contains('unread')) {
        existing.classList.remove('unread');
        var badge = existing.querySelector('.unread-badge');
        if (badge) badge.remove();
        var markBtn = existing.querySelector('.mark-read-btn');
        if (markBtn) markBtn.remove();
      }
    }
    return;
  }
  seenInboxIds.add(msg.id);
  if (msg._meta && msg._meta.type === 'read-receipt') return;

  // Deduplicate multicast copies (same message sent to multiple recipients)
  if (msg._meta && msg._meta.recipients && msg._meta.recipients.length > 1 && msg.threadId) {
    var mcastKey = msg.threadId + '|' + msg.from + '|' + (msg.replyTo || '') + '|' + msg.body.slice(0, 200);
    if (seenMulticastKeys.has(mcastKey)) return;
    seenMulticastKeys.add(mcastKey);
  }

  var empty = chat.querySelector('.empty-state');
  if (empty) empty.remove();

  var div = document.createElement('div');
  div.className = 'message inbox' + (msg.read ? '' : ' unread');
  div.dataset.inboxId = msg.id;
  div.dataset.timestamp = msg.timestamp;
  applySenderStyle(div, msg.from);

  var meta = document.createElement('div');
  meta.className = 'meta';
  var identitySpan = document.createElement('span');
  identitySpan.className = 'identity';
  identitySpan.textContent = msg.from;
  meta.appendChild(identitySpan);
  if (msg.to) {
    var recipientSpan = document.createElement('span');
    recipientSpan.className = 'recipient';
    recipientSpan.appendChild(document.createTextNode(' \u2192 '));
    var addrs = (msg._meta && msg._meta.recipients && msg._meta.recipients.length > 1)
      ? msg._meta.recipients.filter(function(a) { return a !== msg.from; })
      : [msg.to];
    addrs.forEach(function(addr, i) {
      if (i > 0) recipientSpan.appendChild(document.createTextNode(', '));
      var addrSpan = document.createElement('span');
      addrSpan.className = 'addr';
      addrSpan.textContent = addr;
      recipientSpan.appendChild(addrSpan);
    });
    meta.appendChild(recipientSpan);
  }
  var inboxBadge = document.createElement('span');
  inboxBadge.className = 'badge inbox-badge';
  inboxBadge.textContent = 'inbox';
  meta.appendChild(inboxBadge);
  if (!msg.read) {
    var unreadBadge = document.createElement('span');
    unreadBadge.className = 'badge unread-badge';
    unreadBadge.textContent = 'unread';
    meta.appendChild(unreadBadge);
  }
  var timeSpan = document.createElement('span');
  timeSpan.textContent = formatTime(msg.timestamp);
  meta.appendChild(timeSpan);

  var body = document.createElement('div');
  body.className = 'body';
  setMarkdownBody(body, msg.body);
  meta.appendChild(createMarkdownToggle(body));
  div.appendChild(meta);

  var uuidLine = document.createElement('div');
  uuidLine.className = 'meta';
  uuidLine.style.marginTop = '-8px';
  uuidLine.style.marginBottom = '8px';
  uuidLine.textContent = msg.id;
  div.appendChild(uuidLine);
  div.appendChild(body);
  if (msg.replyTo) div.appendChild(createReplyLink(msg.replyTo));

  var actions = document.createElement('div');
  actions.className = 'inbox-actions';
  if (!msg.read) {
    var markReadBtn = document.createElement('button');
    markReadBtn.className = 'mark-read-btn';
    markReadBtn.textContent = 'Mark read';
    markReadBtn.onclick = function() { markInboxRead(msg.id, serverUrl, div); };
    actions.appendChild(markReadBtn);
  }
  var delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.onclick = function() { deleteInboxMessage(msg.id, serverUrl, div); };
  actions.appendChild(delBtn);
  div.appendChild(actions);

  insertChronologically(div);
  if (initialLoadDone && autoScroll) scrollToBottom();
}

function insertChronologically(el) {
  var ts = el.dataset.timestamp || el.dataset.id;
  var children = chat.children;
  for (var i = children.length - 1; i >= 0; i--) {
    var child = children[i];
    var childTs = child.dataset.timestamp || child.dataset.id || '';
    if (childTs && childTs <= ts) {
      child.after(el);
      return;
    }
  }
  chat.prepend(el);
}

async function loadInbox(host) {
  try {
    var params = 'all=true&receipts=false';
    if (inboxInitialLoadDone && latestInboxTimestamp) {
      params += '&since=' + encodeURIComponent(latestInboxTimestamp);
    }
    var res = await fetch(host.url + '/api/inbox?' + params);
    if (!res.ok) throw new Error(res.status);
    var data = await res.json();
    data.messages.forEach(function(msg) { addInboxMessage(msg, host.url); });
    return data.unreadCount;
  } catch (err) {
    console.warn('Failed to load inbox from ' + host.identity + ':', err);
    return 0;
  }
}

function updateUnreadCounts(counts) {
  HOSTS.forEach(function(h, i) {
    var el = document.getElementById('unread-' + i);
    var c = counts[i] || 0;
    el.textContent = c > 0 ? '(' + c + ')' : '';
  });
}

var refreshInboxPromise = null;
async function refreshInbox() {
  if (refreshInboxPromise) return refreshInboxPromise;
  refreshInboxPromise = (async function() {
    var counts = [];
    for (var i = 0; i < HOSTS.length; i++) {
      var count = await loadInbox(HOSTS[i]);
      counts.push(count);
    }
    updateUnreadCounts(counts);
  })();
  try { return await refreshInboxPromise; } finally { refreshInboxPromise = null; }
}

function startInboxPoll() {
  if (inboxPollTimer) clearInterval(inboxPollTimer);
  inboxPollTimer = setInterval(refreshInbox, INBOX_POLL_INTERVAL);
}

async function markInboxRead(id, serverUrl, el) {
  try {
    var res = await fetch(serverUrl + '/api/inbox/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    if (!res.ok) throw new Error(res.status);
    el.classList.remove('unread');
    var badge = el.querySelector('.unread-badge');
    if (badge) badge.remove();
    var btn = el.querySelector('.mark-read-btn');
    if (btn) btn.remove();
    refreshInbox();
  } catch (err) {
    console.error('Mark read failed:', err);
  }
}

async function deleteInboxMessage(id, serverUrl, el) {
  try {
    var res = await fetch(serverUrl + '/api/inbox/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    if (!res.ok) throw new Error(res.status);
    el.remove();
    refreshInbox();
  } catch (err) {
    console.error('Delete inbox message failed:', err);
  }
}

// Populate address select from all host registries
async function loadAddresses() {
  var select = document.getElementById('addr-select');
  var options = [];
  for (var i = 0; i < HOSTS.length; i++) {
    try {
      var res = await fetch(HOSTS[i].url + '/api/registry');
      if (res.ok) {
        var data = await res.json();
        (data.instances || []).forEach(function(inst) {
          options.push(inst.address || (HOSTS[i].identity + '/' + inst.instance));
        });
      }
    } catch (e) {}
    // Also add bare host as a fallback address
    options.push(HOSTS[i].identity);
  }
  // Deduplicate
  var unique = [];
  var seen = {};
  options.forEach(function(addr) {
    if (!seen[addr]) { seen[addr] = true; unique.push(addr); }
  });
  while (select.firstChild) select.removeChild(select.firstChild);
  if (unique.length === 0) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no addresses)';
    select.appendChild(opt);
  } else {
    unique.forEach(function(addr) {
      var opt = document.createElement('option');
      opt.value = addr;
      opt.textContent = addr;
      select.appendChild(opt);
    });
  }
}

// Initialize
(async function() {
  for (var i = 0; i < HOSTS.length; i++) {
    await checkHealth(HOSTS[i], i);
  }
  await loadAddresses();
  await refreshInbox();
  inboxInitialLoadDone = true;
  scrollToBottom(true);
  initialLoadDone = true;
  for (var i = 0; i < HOSTS.length; i++) {
    connectSSE(HOSTS[i], i);
  }
  startInboxPoll();
})();
<\/script>
</body>
</html>`;
}

interface WebServerOptions {
  port?: number;
  host?: string;
}

export function createWebServer(options: WebServerOptions = {}) {
  const config = loadConfig();
  const port = options.port ?? 3180;
  const host = options.host ?? '0.0.0.0';
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { method } = req;
    const url = req.url || '/';

    // Proxy route: /proxy/:peer/api/*
    const reqUrl = new URL(url, 'http://localhost');
    const proxyMatch = reqUrl.pathname.match(/^\/proxy\/([^/]+)(\/api\/.*)$/);
    if (proxyMatch) {
      const [, peerIdentity, apiPath] = proxyMatch;
      proxyRequest(config, peerIdentity!, apiPath! + reqUrl.search, req, res);
      return;
    }

    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      const html = getHTML(config);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    if (method === 'POST' && url === '/send') {
      try {
        const rawBody = await readBody(req);
        const { body: msgBody, to } = JSON.parse(rawBody);
        if (!msgBody) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing body' }));
          return;
        }
        if (!to) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing to address' }));
          return;
        }

        log.info(`Web UI sending inbox message to "${to}"`);
        const from = getFullAddress(config);
        const { host } = (await import('./address.ts')).parseAddress(to);
        const peerIdentity = host && host !== config.identity ? host : null;

        // Route to the right host's /api/inbox
        if (peerIdentity) {
          proxyRequest(config, peerIdentity, '/api/inbox', Object.assign(req, {
            // We can't re-pipe, so make a fresh request
          }) as IncomingMessage, res);
          // Actually, use direct proxy POST instead
          const target = resolveProxyTarget(config, peerIdentity);
          if (!target) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown peer: ${peerIdentity}` }));
            return;
          }
          const payload = JSON.stringify({ from, body: msgBody, to });
          const targetUrl = new URL('/api/inbox', target.baseUrl);
          const proxyRes = await new Promise<{ status: number; data: string }>((resolve, reject) => {
            const proxyReq = target.requestFn(targetUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
                'Authorization': `Bearer ${target.token}`,
              },
              ...target.requestOpts,
            }, (r) => {
              let data = '';
              r.on('data', (chunk: Buffer) => { data += chunk; });
              r.on('end', () => resolve({ status: r.statusCode || 500, data }));
            });
            proxyReq.on('error', reject);
            proxyReq.write(payload);
            proxyReq.end();
          });
          res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
          res.end(proxyRes.data);
        } else {
          // Local — proxy to local ICC server
          const target = resolveProxyTarget(config, config.identity);
          if (!target) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot resolve local server' }));
            return;
          }
          const payload = JSON.stringify({ from, body: msgBody, to });
          const targetUrl = new URL('/api/inbox', target.baseUrl);
          const proxyRes = await new Promise<{ status: number; data: string }>((resolve, reject) => {
            const proxyReq = target.requestFn(targetUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
                'Authorization': `Bearer ${target.token}`,
              },
              ...target.requestOpts,
            }, (r) => {
              let data = '';
              r.on('data', (chunk: Buffer) => { data += chunk; });
              r.on('end', () => resolve({ status: r.statusCode || 500, data }));
            });
            proxyReq.on('error', reject);
            proxyReq.write(payload);
            proxyReq.end();
          });
          res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
          res.end(proxyRes.data);
        }
      } catch (err) {
        log.error(`Web UI send failed: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };

  // Web UI: always plain HTTP — Ed25519 certs aren't supported by browsers
  const server = createServer(handler);

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const actualPort = (server.address() as { port: number }).port;
          log.info(`Web server listening on HTTP ${host}:${actualPort}`);
          resolve({ port: actualPort, host });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
    server,
  };
}
