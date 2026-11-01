#!/usr/bin/env node
/*!
 * Omni-Web-MCP · mcp-hub.js
 * ---------------------------------------------------------------------------
 * A zero-dependency local bridge that turns any web page into an MCP surface.
 *
 *   browser page  --(WebSocket /ws)-->  mcp-hub  --(stdio JSON-RPC / HTTP)-->  AI agent
 *
 * It is deliberately built on the Node.js standard library only:
 *   http / crypto / fs / path / url / os / child_process
 * No npm install, no bundler, no native modules — friendly for locked-down
 * Windows 7 + 8GB hosts. Node >= 14 is all that is required.
 *
 * What it exposes to MCP clients (DSH, Claude Desktop, OpenAI function callers):
 *   tools: list_pages | get_dom_tree | click_element | input_text | scroll_page
 *
 * Run it:
 *   node mcp-hub.js                      # local hub on 127.0.0.1:8787
 *   node mcp-hub.js --stdio              # MCP server on stdin/stdout + hub
 *   node mcp-hub.js --port 9000 --token  # advanced
 *
 * MIT License · Copyright (c) 2026 Omni-Web-MCP contributors
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '1.0.0';
const PROTOCOL = 1;
const NAME = 'omni-web-mcp';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MCP_PROTOCOL_VERSION = '2024-11-05';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PAGE_TIMEOUT_MS = 30000;
const MAX_INBOUND_FRAME = 8 * 1024 * 1024;   // hard cap per WebSocket frame
const MAX_HTTP_BODY = 4 * 1024 * 1024;
const HEARTBEAT_MS = 20000;
const STALE_CLIENT_MS = 90000;
const DEFAULT_TOKEN_FILE = '.omni-web-mcp-token';

/* ========================================================================= *
 * Small utilities
 * ========================================================================= */

function parseArgs(argv) {
  const args = { _: [] };
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '--') { out._ = out._.concat(argv.slice(i + 1)); break; }
    if (raw.startsWith('--')) {
      const name = raw.slice(2);
      const eq = name.indexOf('=');
      if (eq >= 0) { out[name.slice(0, eq)] = name.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[name] = true;
      else { out[name] = next; i += 1; }
    } else if (raw.startsWith('-') && raw.length > 1) {
      out[raw.slice(1)] = true;
    } else {
      out._.push(raw);
    }
  }
  delete out._;
  return out;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function now() { return Date.now(); }

function log(...parts) {
  if (process.env.OMNI_HUB_QUIET === '1') return;
  const stamp = new Date().toISOString().replace('T', ' ').replace(/\..*$/, '');
  const line = parts.map((p) => (typeof p === 'string' ? p : safeStringify(p))).join(' ');
  process[mcpMode ? 'stderr' : 'stdout'].write(`[${stamp}] ${line}\n`);
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

function originFor(hostHeader, forwardedProto) {
  if (!hostHeader) return null;
  const proto = forwardedProto === 'https' ? 'https' : 'http';
  return `${proto}://${hostHeader}`;
}

function randomToken() {
  // 192 bits of entropy, hex encoded — used both as WS pairing token and as
  // HTTP Bearer credential for the local REST API.
  return crypto.randomBytes(24).toString('hex');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function timingSafeEqualString(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

/* ========================================================================= *
 * Token resolution
 * ========================================================================= */

function resolveToken(options, baseDir) {
  // 1) explicit CLI flag (takes precedence)
  if (options.token && typeof options.token === 'string') {
    const token = options.token.trim();
    if (token.length >= 16) return { token, explicit: true };
    throw new Error('The token passed with --token must be at least 16 characters.');
  }
  // 2) environment variable (handy for CI / launch scripts)
  if (process.env.OMNI_WEB_MCP_TOKEN) {
    const token = String(process.env.OMNI_WEB_MCP_TOKEN).trim();
    if (token.length >= 16) return { token, explicit: true };
    throw new Error('OMNI_WEB_MCP_TOKEN must be at least 16 characters.');
  }
  // 3) token file shared across hub restarts
  const tokenFile = (options['token-file'] && String(options['token-file'])) ||
    path.join(baseDir, DEFAULT_TOKEN_FILE);
  try {
    if (fs.existsSync(tokenFile)) {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      if (token.length >= 16) return { token, explicit: true, tokenFile };
    }
  } catch (err) {
    log('warn: could not read token file', tokenFile, '-', err.message);
  }
  // 4) generate, persist (0600) and reuse
  const token = randomToken();
  try {
    fs.writeFileSync(tokenFile, token + '\n', { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tokenFile, 0o600);
    else try { fs.chmodSync(tokenFile, 0o600); } catch (noop) { /* Windows: best effort */ }
  } catch (err) {
    log('warn: could not persist token file', tokenFile, '-', err.message);
  }
  return { token, explicit: false, tokenFile };
}

/* ========================================================================= *
 * RFC6455 — minimal, dependency-free WebSocket server codec
 * ========================================================================= */

class WsReceiver {
  // Accumulates and parses masked client frames into whole messages.
  constructor(maxPayload) {
    this.maxPayload = maxPayload || MAX_INBOUND_FRAME;
    this.total = 0;
    this.payload = [];      // completed message parts (Buffers)
    this.messageLength = 0;
    this.fragmentOpcode = 0;
    this.state = 0;         // 0 header byte0, 1 header byte1, 2 ext-len, 3 mask, 4 payload
    this.h0 = 0;
    this.h1 = 0;
    this.ext = null;
    this.mask = null;
    this.frameLen = 0;
    this.frameRead = 0;
    this.frameBuf = null;
    this.done = false;
  }

  push(chunk, emit) {
    if (this.done) return;
    this.total += chunk.length;
    if (this.total > this.maxPayload * 4) {
      this.failed = new Error('Frame flood limit exceeded');
      this.done = true;
      return;
    }
    let data = chunk;
    while (data && data.length) {
      let need;
      switch (this.state) {
        case 0:
          this.h0 = data[0]; data = data.slice(1); this.state = 1;
          if (data.length === 0) break;
          /* falls through */
        case 1: {
          this.h1 = data[0]; data = data.slice(1); this.state = 2;
          if ((this.h1 & 0x80) === 0) { this.failed = new Error('Client frames must be masked'); this.done = true; return; }
          this.ext = (this.h1 & 0x7f) === 126 ? 2 : (this.h1 & 0x7f) === 127 ? 8 : 0;
          this.frameLen = this.h1 & 0x7f;
          this.extRead = 0;
          this.pendingExt = null;
          this.mask = null;
          break;
        }
        case 2:
          need = this.ext - (this.extRead || 0);
          if (data.length < need) { this.pendingExt = Buffer.concat([this.pendingExt || Buffer.alloc(0), data].filter(Boolean)); this.extRead = (this.extRead || 0) + data.length; data = null; break; }
          let extData = data;
          if (this.pendingExt) { extData = Buffer.concat([this.pendingExt, data.slice(0, need)]); this.pendingExt = null; }
          data = data.slice(need);
          this.extRead = 0;
          if (this.ext === 2) this.frameLen = extData.readUInt16BE(0);
          else if (this.ext === 8) {
            const hi = extData.readUInt32BE(0);
            const lo = extData.readUInt32BE(4);
            if (hi !== 0 || lo > this.maxPayload) { this.failed = new Error('Frame too large'); this.done = true; return; }
            this.frameLen = lo;
          }
          if (this.frameLen > this.maxPayload) { this.failed = new Error('Frame too large'); this.done = true; return; }
          this.state = 3;
          break;
        case 3: {
          const maskNeed = 4 - (this.mask ? this.mask.length : 0);
          if (data.length < maskNeed) {
            this.mask = Buffer.concat([this.mask || Buffer.alloc(0), data].filter(Boolean));
            data = null; break;
          }
          this.mask = Buffer.concat([this.mask || Buffer.alloc(0), data.slice(0, maskNeed)]);
          data = data.slice(maskNeed);
          this.frameRead = 0;
          this.frameBuf = this.frameLen > 0 ? Buffer.allocUnsafe(this.frameLen) : null;
          this.state = 4;
          break;
        }
        case 4: {
          if (!this.frameBuf) { this._finishFrame(emit); break; }
          const copy = Math.min(data.length, this.frameLen - this.frameRead);
          data.copy(this.frameBuf, this.frameRead, 0, copy);
          this.frameRead += copy;
          data = data.slice(copy);
          if (this.frameRead === this.frameLen) this._finishFrame(emit);
          break;
        }
        default:
          this.done = true; return;
      }
    }
    if (this.total > 64 * 1024 * 1024) { this.failed = new Error('Flood limit exceeded'); this.done = true; }
  }

  _finishFrame(emit) {
    const fin = (this.h0 & 0x80) !== 0;
    const opcode = this.h0 & 0x0f;
    const masked = (this.h1 & 0x80) !== 0;
    let payload = this.frameBuf;
    if (masked && payload && this.mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= this.mask[i % 4];
    }
    if (opcode >= 8 && opcode <= 10) {
      // control frames must be FIN and <= 125 bytes
      if (!fin || this.frameLen > 125) { this.failed = new Error('Invalid control frame'); this.done = true; return; }
      if (opcode === 8) {
        let code = 1000; let reason = '';
        if (payload && payload.length >= 2) { code = payload.readUInt16BE(0); reason = payload.slice(2).toString('utf8'); }
        this.done = true;
        emit('close', { code, reason });
      } else if (opcode === 9) {
        emit('ping', payload || Buffer.alloc(0));
      } else if (opcode === 10) {
        emit('pong', payload || Buffer.alloc(0));
      }
    } else if (opcode === 0 || opcode === 1 || opcode === 2) {
      if (opcode !== 0) this.fragmentOpcode = opcode;
      else if (this.fragmentOpcode === 0) { this.failed = new Error('Unexpected continuation frame'); this.done = true; return; }
      if (payload && payload.length) { this.payload.push(payload); this.messageLength += payload.length; }
      if (this.messageLength > this.maxPayload) { this.failed = new Error('Message too large'); this.done = true; return; }
      if (fin) {
        const joined = this.payload.length === 1 ? this.payload[0] : Buffer.concat(this.payload);
        emit('message', { opcode: this.fragmentOpcode || 1, data: joined });
        this.payload = []; this.messageLength = 0; this.fragmentOpcode = 0;
      }
    } else {
      this.failed = new Error('Unknown opcode ' + opcode); this.done = true;
    }
    this.frameBuf = null;
    this.state = 0;
  }
}

function writeWsFrame(socket, opcode, payload) {
  // Server-to-client frames are never masked.
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(data.length / 4294967296), 2);
    header.writeUInt32BE(data.length % 4294967296, 6);
  }
  socket.write(Buffer.concat([header, data]));
}

class WsConnection {
  constructor(socket) {
    const self = this;
    this.socket = socket;
    this.closed = false;
    this.receiver = new WsReceiver(MAX_INBOUND_FRAME);
    socket.setNoDelay(true);
    socket.setTimeout(0);
    this.handlers = { message: [], close: [], ping: [], error: [] };
    const emit = (type, arg) => {
      const list = self.handlers[type] || [];
      for (let i = 0; i < list.length; i += 1) {
        try { list[i](arg); } catch (err) { /* handler bug */ }
      }
      if (type === 'message') self._message(arg);
    };
    this._emit = emit;
    socket.on('data', (chunk) => {
      self.receiver.push(chunk, emit);
      if (self.receiver.failed) { self.drop(1002, 'protocol error'); }
    });
    socket.on('error', () => { self._finish(1006, 'socket error'); });
    socket.on('close', () => { self._finish(1006, 'closed'); });
    socket.on('end', () => { try { socket.end(); } catch (noop) {} });
  }

  _message(frame) {
    if (frame.opcode === 1 || frame.opcode === 2) {
      let parsed = null;
      try { parsed = JSON.parse(frame.data.toString('utf8')); } catch (err) { parsed = null; }
      this._dispatch(parsed, frame);
    }
  }

  _dispatch(parsed, frame) {
    const list = this.handlers.raw || [];
    for (let i = 0; i < list.length; i += 1) list[i](parsed, frame);
  }

  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  }

  send(obj) {
    if (this.closed) return false;
    try { writeWsFrame(this.socket, 1, safeStringify(obj)); return true; } catch (err) { return false; }
  }

  ping() { if (!this.closed) { try { writeWsFrame(this.socket, 9, Buffer.alloc(0)); } catch (noop) {} } }

  drop(code, reason) { this._finish(code, reason); }

  close(code, reason) { this._finish(code, reason, true); }

  _finish(code, reason, sendClose) {
    if (this.closed) return;
    this.closed = true;
    try {
      if (sendClose && this.socket.writable) {
        const body = Buffer.alloc(2 + Buffer.byteLength(reason || '', 'utf8'));
        body.writeUInt16BE(code, 0);
        Buffer.from(String(reason || ''), 'utf8').copy(body, 2);
        writeWsFrame(this.socket, 8, body);
      }
      this.socket.end();
      this.socket.destroySoon();
    } catch (noop) { /* teardown */ }
    const list = this.handlers.close || [];
    for (let i = 0; i < list.length; i += 1) { try { list[i](code, reason); } catch (err) {} }
    this.handlers.close = [];
  }
}

function acceptWebSocket(req, socket, head) {
  const headers = req.headers || {};
  const key = String(headers['sec-websocket-key'] || '');
  let accept = null;
  try {
    accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  } catch (err) { return false; }
  if (!key || key.length !== 24 || headers['sec-websocket-version'] !== '13' || accept === null) return false;
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`
  ];
  // RFC6455 §4.2.2: 仅当客户端请求中列出子协议时服务端才可回该头，且必须从
  // 客户端列表中选择。无条件回 Sec-WebSocket-Protocol 会让 Chromium 与
  // Node(undici) 的客户端握手直接失败（浏览器表现为 WebSocket 立即 close）。
  const requested = headers['sec-websocket-protocol'];
  if (requested) {
    const items = String(requested).split(',').map((s) => s.trim()).filter(Boolean);
    const chosen = items.indexOf('json') >= 0 ? 'json' : items[0];
    if (chosen) lines.push(`Sec-WebSocket-Protocol: ${chosen}`);
  }
  if (head && head.length) socket.unshift(head);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  return true;
}

/* ========================================================================= *
 * Tool registry (OpenAI function-call friendly)
 * ========================================================================= */

const TOOLS = [
  {
    name: 'list_pages',
    summary: 'List every web page currently connected to the Omni-Web-MCP hub.',
    description: 'Returns the live web pages attached to the local hub. Each entry has a clientId, url, title and lastSeenAt. Use the clientId with the other tools to target a specific page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_dom_tree',
    summary: 'Capture a compact, numbered DOM snapshot of the page.',
    description: 'Extracts the visible page as structured data: rendered text, a heading outline, and a numbered list of interactive elements (links, buttons, inputs, selects, contenteditable). Action tools target elements by their numeric id.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'Optional target page; defaults to the most recently active page.' },
        include_text: { type: 'boolean', default: true, description: 'Include the rendered visible text of the page.' },
        include_interactive: { type: 'boolean', default: true, description: 'Include numbered interactive elements.' },
        include_outline: { type: 'boolean', default: true, description: 'Include the heading/section outline.' },
        max_text_chars: { type: 'integer', minimum: 100, maximum: 200000, default: 12000, description: 'Character cap for the text field.' },
        max_elements: { type: 'integer', minimum: 1, maximum: 1000, default: 150, description: 'Cap for numbered interactive elements.' },
        privacy: { type: 'string', enum: ['default', 'strict'], default: 'default', description: 'strict masks every input value.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'click_element',
    summary: 'Click an interactive element by its numeric id.',
    description: 'Performs a real click (focus + click) on the element that get_dom_tree numbered with the given id. Returns the refreshed page state and whether a navigation may have happened.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'The numeric element id returned by get_dom_tree.' },
        clientId: { type: 'string', description: 'Optional target page.' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'input_text',
    summary: 'Type text into an input, textarea, select or contenteditable element.',
    description: 'Sets the value of an editable element identified by its numeric id, dispatching input/change so modern frameworks react. Optionally submits the surrounding form.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'The numeric element id returned by get_dom_tree.' },
        text: { type: 'string', description: 'The text to type. Cleared first, then replaced.' },
        submit: { type: 'boolean', default: false, description: 'Press Enter / submit the form afterwards.' },
        clientId: { type: 'string', description: 'Optional target page.' }
      },
      required: ['id', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'scroll_page',
    summary: 'Scroll the page or a scrollable container.',
    description: 'Scrolls in a direction or to the top/bottom. When an element id is given, scrolls that container instead of the window.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'], default: 'down' },
        amount: { type: 'number', minimum: 1, maximum: 100, default: 3, description: 'Scroll steps for relative directions.' },
        element_id: { type: ['integer', 'string'], description: 'Optional container element id to scroll.' },
        clientId: { type: 'string', description: 'Optional target page.' }
      },
      additionalProperties: false
    }
  }
];

function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

function openAITools() {
  return {
    tools: TOOLS.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.summary, parameters: t.inputSchema }
    }))
  };
}

/* ========================================================================= *
 * MCP layer — JSON-RPC 2.0 over stdio, plus an HTTP REST surface
 * ========================================================================= */

function jsonRpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function jsonRpcError(id, code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id, error: e };
}

function toolCallResult(result, isError) {
  const text = typeof result === 'string' ? result : safeStringify(result, null, 2);
  return { content: [{ type: 'text', text }], isError: !!isError };
}

/* ========================================================================= *
 * The hub
 * ========================================================================= */

class Hub {
  constructor(options) {
    this.options = options;
    this.token = options.token;
    this.pages = new Map();           // clientId -> page record
    this.sseClients = new Set();
    this.seq = 1;
    this.startedAt = now();
    this.server = null;
    this.heartbeatTimer = null;
  }

  /* -------- bookkeeping ------------------------------------------------ */

  pageList() {
    const list = [];
    this.pages.forEach((page) => {
      list.push({
        clientId: page.clientId,
        url: page.client && page.client.url,
        title: page.client && page.client.title,
        lang: page.client && page.client.lang,
        userAgent: page.client && page.client.userAgent,
        connectedAt: page.connectedAt,
        lastSeenAt: page.lastSeenAt
      });
    });
    list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    return list;
  }

  choosePage(selector) {
    if (selector && typeof selector === 'string') {
      const direct = this.pages.get(selector);
      if (direct) return direct;
      const needle = selector.toLowerCase();
      for (const page of this.pages.values()) {
        const url = String((page.client && page.client.url) || '').toLowerCase();
        const title = String((page.client && page.client.title) || '').toLowerCase();
        if (url.includes(needle) || title.includes(needle)) return page;
      }
      const err = new Error(`No connected page matches clientId/url/title "${selector}".`);
      err.code = 'NO_SUCH_PAGE';
      throw err;
    }
    const list = this.pageList();
    if (!list.length) {
      const err = new Error('No web page is connected to the hub yet. Open a page that includes omni-web-mcp.js and let it pair.');
      err.code = 'NO_WEB_PAGE';
      throw err;
    }
    return this.pages.get(list[0].clientId);
  }

  broadcast(type, payload) {
    const event = { type, at: new Date().toISOString(), ...(payload || {}) };
    for (const res of this.sseClients) {
      try { res.write(`data: ${safeStringify(event)}\n\n`); } catch (err) { this.sseClients.delete(res); }
    }
    return event;
  }

  /* -------- page (WebSocket) sessions ---------------------------------- */

  attachPage(socket, req) {
    const self = this;
    const remote = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    let page = null;
    let helloTimer = setTimeout(() => {
      if (page) return;
      try { socket.close(4003, 'hello timeout'); } catch (noop) {}
    }, 6000);

    socket.on('close', (code, reason) => {
      clearTimeout(helloTimer);
      if (page) self.removePage(page, String(code) + (reason ? ' ' + reason : ''));
    });

    socket.on('raw', (parsed) => {
      if (page) { page.lastSeenAt = now(); }
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.type === 'hello' && !page) {
        clearTimeout(helloTimer);
        self.handleHello(socket, req, parsed, (record) => { page = record; });
      } else if (parsed.type === 'ping' && page) {
        page.lastSeenAt = now();
        socket.send({ v: PROTOCOL, type: 'pong', t: parsed.t || now() });
      } else if (parsed.type === 'pong' && page) {
        page.lastSeenAt = now();
      } else if (parsed.type === 'result' && page) {
        page.receiveResult(parsed);
      } else if (parsed.type === 'error' && page) {
        page.receiveResult(parsed);
      }
    });

    socket.on('error', () => {
      clearTimeout(helloTimer);
      if (page) self.removePage(page, 'socket error');
    });
  }

  handleHello(socket, req, message, setPage) {
    const self = this;
    const remote = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    const supplied = String((message && message.token) || '');
    const client = (message && message.client) || {};
    if (!supplied || !timingSafeEqualString(supplied, self.token)) {
      try { socket.close(4001, 'unauthorized'); } catch (noop) {}
      self.broadcast('page.rejected', { reason: 'unauthorized', remote });
      return;
    }
    if (message && message.v !== PROTOCOL) {
      log('warn: client protocol', message && message.v, 'expected', PROTOCOL);
    }
    const clientId = crypto.randomBytes(12).toString('hex');
    const page = {
      clientId,
      client: {
        name: client.name || 'web-page',
        url: client.url || '',
        title: client.title || '',
        lang: client.lang || '',
        userAgent: client.userAgent || ''
      },
      connectedAt: now(),
      lastSeenAt: now(),
      socket,
      pending: new Map(),
      nextId: 1
    };
    page.receiveResult = (msg) => {
      const id = msg && msg.id;
      const entry = page.pending.get(id);
      if (!entry) return;
      page.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.type === 'error' || msg.ok === false || msg.error) {
        entry.reject(Object.assign(new Error(String((msg.error && msg.error.message) || msg.message || 'Page reported an error')), { code: (msg.error && msg.error.code) || msg.code || 'PAGE_ERROR', pageError: msg.error || msg }));
      } else {
        entry.resolve(msg.result !== undefined ? msg.result : (msg.data !== undefined ? msg.data : msg));
      }
    };
    page.call = (action, params) => new Promise((resolve, reject) => {
      if (socket.closed) { const e = new Error('The web page connection is closed.'); e.code = 'CONNECTION_LOST'; return reject(e); }
      const id = 'r' + (page.nextId++);
      const timer = setTimeout(() => {
        page.pending.delete(id);
        const e = new Error(`Timed out waiting for the page to respond to ${action} after ${self.options.pageTimeout}ms.`);
        e.code = 'TIMEOUT';
        reject(e);
      }, self.options.pageTimeout);
      page.pending.set(id, { resolve, reject, timer });
      socket.send({ v: PROTOCOL, type: 'request', id, action, params: params || {} });
    });
    page.pendingRejectAll = (code, message) => {
      page.pending.forEach((entry) => {
        clearTimeout(entry.timer);
        const e = new Error(message); e.code = code; entry.reject(e);
      });
      page.pending.clear();
    };
    this.pages.set(clientId, page);
    setPage(page);
    socket.send({ v: PROTOCOL, type: 'welcome', clientId, hub: NAME, version: VERSION });
    const list = self.pageList().map((p) => ({ clientId: p.clientId, url: p.url, title: p.title }));
    self.broadcast('page.connected', { clientId, url: page.client.url, title: page.client.title, pages: list });
    log('page+  ', clientId.slice(0, 8), page.client.url);
  }

  removePage(page, why) {
    if (!this.pages.has(page.clientId)) return;
    this.pages.delete(page.clientId);
    try { page.pendingRejectAll('CONNECTION_LOST', 'The web page disconnected (' + why + ').'); } catch (noop) {}
    const list = this.pageList().map((p) => ({ clientId: p.clientId, url: p.url, title: p.title }));
    this.broadcast('page.disconnected', { clientId: page.clientId, why, pages: list });
    log('page-  ', page.clientId.slice(0, 8), why);
  }

  /* -------- tool invocation -------------------------------------------- */

  async callTool(name, args) {
    const params = args && typeof args === 'object' ? args : {};
    if (name === 'list_pages') {
      return { pages: this.pageList(), count: this.pages.size, hub: NAME, version: VERSION, uptimeMs: now() - this.startedAt };
    }
    const page = this.choosePage(params.clientId || params.page || params.url);
    const started = now();
    if (name === 'get_dom_tree') {
      const result = await page.call('get_dom_tree', {
        include_text: params.include_text !== false,
        include_interactive: params.include_interactive !== false,
        include_outline: params.include_outline !== false,
        max_text_chars: toInt(params.max_text_chars, 12000),
        max_elements: toInt(params.max_elements, 150),
        privacy: params.privacy === 'strict' ? 'strict' : 'default'
      });
      return this.withMeta(result, page, started);
    }
    if (name === 'click_element') {
      if (params.id === undefined || params.id === null || params.id === '') {
        const e = new Error('click_element requires an element id from get_dom_tree.'); e.code = 'INVALID_ARGS'; throw e;
      }
      const result = await page.call('click_element', { id: params.id });
      return this.withMeta(result, page, started);
    }
    if (name === 'input_text') {
      if (params.id === undefined || params.id === null || params.id === '') {
        const e = new Error('input_text requires an element id from get_dom_tree.'); e.code = 'INVALID_ARGS'; throw e;
      }
      if (typeof params.text !== 'string') {
        const e = new Error('input_text requires a text string.'); e.code = 'INVALID_ARGS'; throw e;
      }
      const result = await page.call('input_text', { id: params.id, text: params.text, submit: params.submit === true });
      return this.withMeta(result, page, started);
    }
    if (name === 'scroll_page') {
      const result = await page.call('scroll_page', {
        direction: params.direction || 'down',
        amount: toInt(params.amount, 3),
        element_id: params.element_id
      });
      return this.withMeta(result, page, started);
    }
    const e = new Error('Unknown tool: ' + name);
    e.code = 'UNKNOWN_TOOL';
    throw e;
  }

  withMeta(result, page, started) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const base = page.client || {};
      return Object.assign({
        page: { clientId: page.clientId, url: base.url, title: base.title },
        durationMs: now() - started
      }, result);
    }
    return result;
  }

  /* -------- HTTP surface ------------------------------------------------ */

  isAuthorized(req) {
    const header = String((req.headers || {}).authorization || '');
    if (/^Bearer\s+/i.test(header)) {
      const supplied = header.replace(/^Bearer\s+/i, '').trim();
      return supplied.length > 0 && timingSafeEqualString(supplied, this.token);
    }
    const query = (req.url || '').split('?')[1] || '';
    const tokenParam = query.split('&').map((kv) => kv.split('=')).find((kv) => kv[0] === 'token');
    if (tokenParam && tokenParam[1]) {
      const supplied = decodeURIComponent(tokenParam[1]);
      return timingSafeEqualString(supplied, this.token);
    }
    return false;
  }

  originAllowed(req) {
    const origin = String((req.headers || {}).origin || '');
    const allowed = this.options.allowOrigins;
    if (!origin || origin === 'null') return true;   // non-browser clients / file:// pages
    if (!allowed || !allowed.length) {
      const host = String((req.headers || {}).host || '');
      const expected = originFor(host, (req.headers || {})['x-forwarded-proto']);
      return !!expected && origin.toLowerCase() === expected.toLowerCase();
    }
    return allowed.some((entry) => entry.toLowerCase() === origin.toLowerCase());
  }

  init(server) {
    const self = this;
    this.server = server;

    server.on('upgrade', (req, socket, head) => {
      const target = String((req.url || '').split('?')[0]);
      if (target !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!acceptWebSocket(req, socket, head)) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const connection = new WsConnection(socket);
      self.attachPage(connection, req);
    });

    this.heartbeatTimer = setInterval(() => {
      const stale = [];
      this.pages.forEach((page) => {
        if (now() - page.lastSeenAt > STALE_CLIENT_MS) stale.push(page);
        else { try { page.socket.ping(); } catch (noop) {} }
      });
      stale.forEach((page) => { try { page.socket.close(4000, 'stale'); } catch (noop) {} self.removePage(page, 'stale'); });
    }, HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  close() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.pages.forEach((page) => page.pendingRejectAll && page.pendingRejectAll('SHUTDOWN', 'The hub is shutting down.'));
    this.pages.clear();
  }

  /* ------- request router (shared by HTTP + MCP stdio) ------------------ */

  async handleApiCall(name, args, meta) {
    const started = now();
    this.broadcast('call.started', { tool: name, at: new Date().toISOString() });
    try {
      const result = await this.callTool(name, args);
      this.broadcast('call.finished', { tool: name, durationMs: now() - started, ok: true });
      return { ok: true, tool: name, result, durationMs: now() - started };
    } catch (err) {
      this.broadcast('call.finished', { tool: name, durationMs: now() - started, ok: false, error: { code: err.code || 'TOOL_ERROR', message: err.message } });
      return {
        ok: false,
        tool: name,
        durationMs: now() - started,
        error: { code: err.code || 'TOOL_ERROR', message: err.message }
      };
    }
  }
}

/* ========================================================================= *
 * HTTP server
 * ========================================================================= */

function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(safeStringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Omni-Web-Mcp': VERSION
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(body);
}

function sendStatic(res, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  } catch (err) {
    sendJson(res, 404, { error: 'not_found', message: 'Static asset not found.' });
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_HTTP_BODY) { req.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function buildHttpHandler(hub, options) {
  return async function handle(req, res) {
    const urlPath = String((req.url || '').split('?')[0]);
    const method = String(req.method || 'GET').toUpperCase();

    if (options.static !== false) {
      if (urlPath === '/' || urlPath === '') {
        const tokenParam = options.demoRedirect ? '?token=' + encodeURIComponent(hub.token) : '';
        res.writeHead(302, { Location: '/demo/' + tokenParam, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (urlPath === '/demo/' || urlPath === '/demo') {
        sendStatic(res, path.join(options.demoDir, 'index.html'), 'text/html; charset=utf-8');
        return;
      }
      if (urlPath === '/omni-web-mcp.js') {
        sendStatic(res, path.join(options.rootDir, 'omni-web-mcp.js'), 'text/javascript; charset=utf-8');
        return;
      }
      if (urlPath === '/mcp-client.js') {
        sendStatic(res, path.join(options.rootDir, 'mcp-client.js'), 'text/javascript; charset=utf-8');
        return;
      }
      if (urlPath === '/favicon.svg') {
        sendStatic(res, path.join(options.demoDir, 'favicon.svg'), 'image/svg+xml');
        return;
      }
    }

    if (urlPath === '/health') {
      sendJson(res, 200, {
        ok: true,
        name: NAME,
        version: VERSION,
        protocol: PROTOCOL,
        hubUrl: originFor(req.headers.host, req.headers['x-forwarded-proto']) || null,
        wsUrl: (originFor(req.headers.host, req.headers['x-forwarded-proto']) || '').replace(/^http/, 'ws') + '/ws',
        pages: hub.pageList().map((p) => ({ clientId: p.clientId, url: p.url, title: p.title })),
        uptimeMs: now() - hub.startedAt
      });
      return;
    }

    if (urlPath === '/api/config') {
      // Same-origin pages may discover their pairing token here; everyone else
      // must already hold the token.
      const sameOrigin = hub.originAllowed(req) && (function () {
        const origin = String(req.headers.origin || '');
        const host = String(req.headers.host || '');
        if (!origin || origin === 'null') return true;
        return origin.toLowerCase() === (originFor(host, req.headers['x-forwarded-proto']) || '').toLowerCase();
      })();
      if (!sameOrigin) {
        sendJson(res, 403, { error: 'forbidden', message: 'Token discovery is restricted to the hub origin.' });
        return;
      }
      const origin = originFor(req.headers.host, req.headers['x-forwarded-proto']);
      sendJson(res, 200, {
        name: NAME,
        version: VERSION,
        protocol: PROTOCOL,
        hub: origin,
        wsUrl: origin ? origin.replace(/^http/, 'ws') + '/ws' : options.wsUrl,
        token: hub.token,
        pageCount: hub.pages.size
      });
      return;
    }

    if (urlPath === '/api/tools' || urlPath === '/tools') {
      sendJson(res, 200, Object.assign({ name: NAME, version: VERSION, protocol: PROTOCOL }, openAITools(), { mcp: { tools: toolList() } }));
      return;
    }

    if (urlPath === '/api/state' || urlPath === '/state') {
      if (!hub.isAuthorized(req)) { sendJson(res, 401, { error: 'unauthorized', message: 'Send the hub token as Authorization: Bearer <token>.' }); return; }
      sendJson(res, 200, { name: NAME, version: VERSION, pages: hub.pageList(), uptimeMs: now() - hub.startedAt });
      return;
    }

    if (urlPath === '/api/call') {
      if (!hub.isAuthorized(req)) { sendJson(res, 401, { error: 'unauthorized', message: 'Send the hub token as Authorization: Bearer <token>.' }); return; }
      if (method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST.' }); return; }
      const body = await readBody(req);
      if (!body) { sendJson(res, 400, { error: 'invalid_body', message: 'Request body too large or unreadable.' }); return; }
      let payload; try { payload = JSON.parse(body.toString('utf8')); } catch (err) { sendJson(res, 400, { error: 'invalid_json', message: err.message }); return; }
      const name = payload && (payload.tool || payload.name || payload.function);
      if (!name) { sendJson(res, 400, { error: 'invalid_args', message: 'Body must be { "tool": "get_dom_tree", "arguments": {} }.' }); return; }
      const args = payload && (payload.arguments || payload.args || payload.parameters || {});
      const outcome = await hub.handleApiCall(name, args);
      sendJson(res, 200, outcome);
      return;
    }

    if (urlPath === '/api/events' || urlPath === '/events') {
      if (!hub.isAuthorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': omni-web-mcp event stream\n\n');
      hub.sseClients.add(res);
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (err) { clearInterval(keepAlive); } }, 15000);
      req.on('close', () => { clearInterval(keepAlive); hub.sseClients.delete(res); });
      return;
    }

    if (urlPath === '/mcp' && method === 'POST') {
      if (!hub.isAuthorized(req)) { sendJson(res, 401, { error: 'unauthorized', message: 'Run this hub with --stdio for MCP transport, or send the hub token as Bearer.' }); return; }
      const body = await readBody(req);
      if (!body) { sendJson(res, 400, { error: 'invalid_body' }); return; }
      let payload; try { payload = JSON.parse(body.toString('utf8')); } catch (err) { sendJson(res, 400, { error: 'invalid_json', message: err.message }); return; }
      const response = await runJsonRpc(hub, payload);
      if (response === 'notification') sendJson(res, 202, { accepted: true });
      else sendJson(res, 200, response);
      return;
    }

    sendJson(res, 404, {
      error: 'not_found',
      message: 'Available: /health /api/config /api/tools /api/state POST /api/call POST /mcp GET /api/events /demo/',
      name: NAME,
      version: VERSION
    });
  };
}

/* ========================================================================= *
 * JSON-RPC dispatch (stdio + POST /mcp)
 * ========================================================================= */

async function runJsonRpc(hub, message) {
  if (!message || typeof message !== 'object') return 'notification';
  if (Array.isArray(message)) {
    const outcomes = [];
    for (const item of message) {
      const out = await runJsonRpc(hub, item);
      if (out !== 'notification') outcomes.push(out);
    }
    return outcomes;
  }
  const method = String(message.method || '');
  const id = message.id === undefined ? null : message.id;
  const params = (message.params && typeof message.params === 'object') ? message.params : {};

  if (id === null || id === undefined) {
    // notification — nothing to reply to
    return 'notification';
  }

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      serverInfo: { name: NAME, version: VERSION }
    });
  }
  if (method === 'ping') return jsonRpcResult(id, { pong: true, at: new Date().toISOString() });
  if (method === 'tools/list') return jsonRpcResult(id, { tools: toolList() });
  if (method === 'resources/list') return jsonRpcResult(id, { resources: [] });
  if (method === 'resources/templates/list') return jsonRpcResult(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return jsonRpcResult(id, { prompts: [] });
  if (method === 'tools/call') {
    const name = String(params.name || params.tool || '');
    const args = params.arguments || params.args || params.parameters || {};
    if (!name) return jsonRpcError(id, -32602, 'tools/call requires params.name.');
    try {
      const result = await hub.callTool(name, args);
      return jsonRpcResult(id, toolCallResult(result, false));
    } catch (err) {
      return jsonRpcResult(id, toolCallResult({ error: { code: err.code || 'TOOL_ERROR', message: err.message } }, true));
    }
  }
  if (method === 'shutdown') return jsonRpcResult(id, {});
  return jsonRpcError(id, -32601, 'Method not found: ' + method + '. Supported: initialize, ping, tools/list, tools/call, shutdown.');
}

/* ========================================================================= *
 * MCP over stdio
 * ========================================================================= */

let mcpMode = false;

function startStdio(hub) {
  const emit = (obj) => process.stdout.write(safeStringify(obj) + '\n');
  process.stdin.setEncoding('utf8');
  let buffer = '';
  const dispatch = async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let message;
    try { message = JSON.parse(trimmed); } catch (err) { return; }
    const response = await runJsonRpc(hub, message);
    if (response === 'notification') return;
    emit(response);
  };
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    // Support both newline-delimited JSON and LSP-style Content-Length frames.
    for (;;) {
      const cl = /^Content-Length:\s*(\d+)\r?\n(?:[^\n\r]*\r?\n)*\r?\n/i.exec(buffer);
      if (cl) {
        const len = parseInt(cl[1], 10);
        const start = cl[0].length;
        if (buffer.length < start + len) return;
        const frame = buffer.slice(start, start + len);
        buffer = buffer.slice(start + len);
        dispatch(frame);
        continue;
      }
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      dispatch(line);
    }
  });
  process.stdin.on('end', () => { setTimeout(() => process.exit(0), 50); });
}

/* ========================================================================= *
 * Banner
 * ========================================================================= */

function showBanner(options, hubUrl, tokenUrl, token) {
  const banner = [
    '',
    '  ╔══════════════════════════════════════════════════════════════╗',
    '  ║                    Omni-Web-MCP ' + VERSION + '                        ║',
    '  ║         Zero-dependency web MCP bridge for AI agents          ║',
    '  ╚══════════════════════════════════════════════════════════════╝',
    '',
    '  MCP / stdio    : node mcp-hub.js --stdio',
    '  Demo page      : ' + tokenUrl,
    '  REST + SSE     : ' + hubUrl + '/api/tools',
    '  Pairing token  : ' + token + (options.explicitToken ? '  (explicit)' : '  (saved to ' + DEFAULT_TOKEN_FILE + ')'),
    '',
    '  Attach a page  : <script src="' + hubUrl + '/omni-web-mcp.js" data-hub="' + hubUrl + '"></script>',
    '',
    '  curl example   : curl ' + hubUrl + '/api/call -H "Authorization: Bearer $TOKEN" \\',
    '                     -H "Content-Type: application/json" \\',
    '                     -d \'{"tool":"list_pages","arguments":{}}\'',
    ''
  ].join('\n');
  process.stdout.write(banner);
}

/* ========================================================================= *
 * Main
 * ========================================================================= */

function main() {
  const argv = parseArgs(process.argv.slice(2));
  mcpMode = argv.stdio === true;
  const rootDir = __dirname;
  const options = {
    rootDir,
    demoDir: argv['demo-dir'] ? path.resolve(argv['demo-dir']) : path.join(rootDir, 'demo'),
    port: toInt(argv.port, DEFAULT_PORT),
    host: typeof argv.host === 'string' ? argv.host : DEFAULT_HOST,
    pageTimeout: toInt(argv['page-timeout'], DEFAULT_PAGE_TIMEOUT_MS),
    allowOrigins: Array.isArray(argv['allow-origin']) ? argv['allow-origin'].map(String)
      : (argv['allow-origin'] && typeof argv['allow-origin'] === 'string' ? [String(argv['allow-origin'])] : []),
    static: argv.static !== false,
    demoRedirect: argv['no-demo-redirect'] !== true,
    wsUrl: 'ws://127.0.0.1:' + toInt(argv.port, DEFAULT_PORT) + '/ws'
  };

  let tokenInfo;
  try { tokenInfo = resolveToken(argv, rootDir); } catch (err) { console.error(err.message); process.exit(2); }
  const hubToken = tokenInfo.token;
  options.token = hubToken;
  options.explicitToken = tokenInfo.explicit;
  options.tokenFile = tokenInfo.tokenFile;

  const hub = new Hub(options);

  const server = http.createServer(buildHttpHandler(hub, options));
  hub.init(server);

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('Port ' + options.port + ' is already in use. Pass --port, or stop the other hub.');
    } else {
      console.error('Hub error:', err && err.message);
    }
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    const hubUrl = 'http://' + options.host + ':' + options.port;
    const tokenUrl = hubUrl + '/demo/?token=' + encodeURIComponent(hubToken);
    if (!mcpMode) showBanner(options, hubUrl, tokenUrl, hubToken);
    else {
      // stdio clients must not see our chatter on stdout; keep it on stderr.
      process.stderr.write('omni-web-mcp ' + VERSION + ' ready; hub at ' + hubUrl + ', demo ' + tokenUrl + '\n');
    }
  });

  startStdio(hub);

  const shutdown = () => {
    try { hub.close(); server.close(); } catch (noop) {}
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
