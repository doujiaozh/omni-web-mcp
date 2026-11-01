/*!
 * Omni-Web-MCP — mcp-client.js
 * Turn any web page into an AI-operable surface with one script tag.
 * v1.0.0 · MIT · No dependencies, no build step.
 *
 * https://github.com/YOUR_GITHUB_USERNAME/omni-web-mcp
 */
(function (window, document) {
  'use strict';

  var VERSION = '1.0.0';
  var PROTOCOL = 1;
  var DEFAULT_HUB = 'ws://127.0.0.1:8787/ws';
  var MAX_VALUE_CHARS = 160;
  var MAX_NAME_CHARS = 140;
  var ELEMENT_LIMIT = 120;
  var TEXT_LIMIT = 5000;

  if (window.OmniWebMCP && window.OmniWebMCP.__omniLoaded) return;

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */

  function currentScript() {
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var src = scripts[i].getAttribute('src') || '';
      if (/(?:mcp-client|omni-web-mcp)\.js(?:[?#]|$)/.test(src)) return scripts[i];
    }
    return null;
  }

  var scriptEl = currentScript();

  function attr(name) {
    if (!scriptEl) return null;
    var value = scriptEl.getAttribute('data-' + name);
    return value === null || value === '' ? null : value;
  }

  function queryParam(name) {
    try {
      var pairs = (window.location.search || '').replace(/^\?/, '').split('&');
      for (var i = 0; i < pairs.length; i += 1) {
        var parts = pairs[i].split('=');
        if (decodeURIComponent(parts[0].replace(/\+/g, ' ')) === name) {
          return decodeURIComponent((parts[1] || '').replace(/\+/g, ' '));
        }
      }
    } catch (err) { /* malformed query string */ }
    return null;
  }

  function metaContent(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  }

  function firstValue() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return '';
  }

  function asBool(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    var text = String(value).toLowerCase();
    if (text === 'false' || text === '0' || text === 'off' || text === 'no') return false;
    if (text === 'true' || text === '1' || text === 'on' || text === 'yes') return true;
    return fallback;
  }

  function scriptOriginHub() {
    try {
      var src = scriptEl && scriptEl.getAttribute('src');
      if (!src) return null;
      var u = new window.URL(src, window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      var samePage = u.origin === window.location.origin;
      var localHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
      if (!samePage && !localHost) return null;
      return (u.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + u.host + '/ws';
    } catch (err) {
      return null;
    }
  }

  function normalizeHub(value) {
    var raw = String(value || DEFAULT_HUB).trim();
    if (!/^[a-z]+:\/\//i.test(raw)) raw = 'ws://' + raw;
    raw = raw.replace(/#.*$/, '');
    if (/^http:\/\//i.test(raw)) raw = raw.replace(/^http:/i, 'ws:');
    if (/^https:\/\//i.test(raw)) raw = raw.replace(/^https:/i, 'wss:');
    if (!/^wss?:\/\//i.test(raw)) return DEFAULT_HUB;
    try {
      var u = new window.URL(raw);
      if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
      return u.href.replace(/#.*$/, '');
    } catch (err) {
      return DEFAULT_HUB;
    }
  }

  var globalConfig = window.OMNI_WEB_MCP_CONFIG || {};
  var config = {
    hub: normalizeHub(firstValue(
      attr('hub'), globalConfig.hub, queryParam('omni_hub'), scriptOriginHub(), DEFAULT_HUB
    )),
    token: String(firstValue(
      attr('token'), globalConfig.token, queryParam('omni_token'),
      metaContent('omni-web-mcp-token'), ''
    )),
    autoConnect: asBool(firstValue(attr('auto-connect'), globalConfig.autoConnect), true),
    badge: asBool(firstValue(attr('badge'), globalConfig.badge), true),
    badgePosition: firstValue(attr('badge-position'), globalConfig.badgePosition, 'bottom-right'),
    label: firstValue(attr('label'), globalConfig.label, ''),
    privacy: firstValue(attr('privacy'), globalConfig.privacy, 'balanced')
  };

  var language = String(navigator.language || navigator.userLanguage || 'en');
  var isZh = /^zh/i.test(language);

  /* ------------------------------------------------------------------ *
   * Runtime state
   * ------------------------------------------------------------------ */

  var state = {
    status: 'idle',
    socket: null,
    clientId: null,
    hub: config.hub,
    token: config.token,
    retries: 0,
    manualClose: false,
    unauthorized: false,
    lastError: null,
    lastSeenAt: 0,
    connectedAt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    connectWaiters: [],
    badge: null,
    badgePanel: null,
    badgeButton: null,
    started: false
  };

  var elementIds = typeof window.WeakMap === 'function' ? new WeakMap() : null;
  var idElements = Object.create(null);
  var idCounter = 0;

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  function now() { return Date.now(); }

  function delay(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function compact(value, max) {
    var text = String(value === null || value === undefined ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    var limit = max || MAX_NAME_CHARS;
    return text.length > limit ? text.slice(0, limit - 1) + '\u2026' : text;
  }

  function errorWithCode(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function emit(name, detail) {
    try {
      var event;
      if (typeof window.CustomEvent === 'function') {
        event = new window.CustomEvent(name, { detail: detail });
      } else {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent(name, false, false, detail);
      }
      // 从 document 派发可顺冒泡链到达 window，document 与 window 两种监听者都能收到。
      var target = (typeof document !== 'undefined' && document.dispatchEvent) ? document : window;
      target.dispatchEvent(event);
    } catch (err) { /* CustomEvent is optional */ }
  }

  function safeStorageGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }

  function httpOriginOfHub() {
    try {
      var u = new window.URL(config.hub);
      return (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
    } catch (err) {
      return 'http://127.0.0.1:8787';
    }
  }

  function sameOrigin(url) {
    try {
      return new window.URL(url).origin === window.location.origin;
    } catch (err) {
      return false;
    }
  }

  function getJson(url, callback) {
    var xhr = new window.XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 3500;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          callback(null, JSON.parse(xhr.responseText));
        } catch (err) {
          callback(err);
        }
      } else {
        callback(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = function () { callback(new Error('Network error')); };
    xhr.ontimeout = function () { callback(new Error('Timeout')); };
    try { xhr.send(); } catch (err) { callback(err); }
  }

  function discoverToken(done) {
    if (config.token) { done(); return; }
    var origin = httpOriginOfHub();
    if (!sameOrigin(origin)) { done(); return; }
    getJson(origin + '/api/config', function (err, data) {
      if (!err && data && data.token) {
        config.token = String(data.token);
        state.token = config.token;
      }
      done();
    });
  }

  /* ------------------------------------------------------------------ *
   * Connection lifecycle
   * ------------------------------------------------------------------ */

  function settleWaiters(ok, err) {
    var waiters = state.connectWaiters.slice();
    state.connectWaiters = [];
    for (var i = 0; i < waiters.length; i += 1) {
      if (ok) waiters[i].resolve(api);
      else waiters[i].reject(err || new Error('Connection cancelled'));
    }
  }

  function setStatus(status, detail) {
    state.status = status;
    if (detail !== undefined) state.lastError = detail || null;
    updateBadge();
    emit('omni-web-mcp:status', {
      status: status,
      clientId: state.clientId,
      hub: state.hub,
      error: state.lastError || null
    });
    if (status === 'connected') {
      settleWaiters(true);
    } else if (status === 'unauthorized' || status === 'unsupported' || status === 'offline') {
      settleWaiters(false, state.lastError || new Error('Omni-Web-MCP ' + status));
    }
  }

  function wsUrlWithToken() {
    return config.hub;
  }

  function send(message) {
    var socket = state.socket;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (err) {
      return false;
    }
  }

  function scheduleReconnect() {
    if (state.manualClose || state.unauthorized) return;
    if (state.reconnectTimer) return;
    if (state.retries >= 8) {
      setStatus('offline', state.lastError || new Error('Hub unreachable after 8 retries'));
      return;
    }
    var wait = Math.min(12000, 800 * Math.pow(2, state.retries)) + Math.floor(Math.random() * 400);
    state.retries += 1;
    setStatus('reconnecting');
    state.reconnectTimer = window.setTimeout(function () {
      state.reconnectTimer = null;
      // A hub restart may rotate its pairing token; refresh it when the
      // page is served from the hub origin before trying again.
      discoverToken(function () { openSocket(); });
    }, wait);
  }

  function clearHeartbeat() {
    if (state.heartbeatTimer) {
      window.clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    clearHeartbeat();
    state.heartbeatTimer = window.setInterval(function () {
      var socket = state.socket;
      if (!socket || socket.readyState !== 1) return;
      if (state.lastSeenAt && now() - state.lastSeenAt > 75000) {
        try { socket.close(4000, 'stale connection'); } catch (err) { /* noop */ }
        return;
      }
      send({ v: PROTOCOL, type: 'ping', t: now() });
    }, 25000);
  }

  function openSocket() {
    if (!window.WebSocket) {
      setStatus('unsupported', new Error('This browser does not support WebSocket.'));
      return;
    }
    var existing = state.socket;
    if (existing && (existing.readyState === 0 || existing.readyState === 1)) return;

    state.manualClose = false;
    state.unauthorized = false;
    state.lastError = null;
    setStatus('connecting');

    var socket;
    try {
      socket = new window.WebSocket(wsUrlWithToken());
    } catch (err) {
      setStatus('offline', err);
      scheduleReconnect();
      return;
    }

    state.socket = socket;
    state.lastSeenAt = now();
    var welcomeTimer = window.setTimeout(function () {
      if (state.socket === socket && !state.clientId) {
        try { socket.close(4003, 'hello timeout'); } catch (err) { /* noop */ }
      }
    }, 6000);

    socket.onopen = function () {
      if (state.socket !== socket) return;
      send({
        v: PROTOCOL,
        type: 'hello',
        token: config.token,
        client: {
          name: config.label || 'web-page',
          url: window.location.href,
          title: document.title,
          lang: document.documentElement.lang || language,
          userAgent: navigator.userAgent
        },
        capabilities: ['get_dom_tree', 'click_element', 'input_text', 'scroll_page']
      });
      state.lastSeenAt = now();
    };

    socket.onmessage = function (event) {
      state.lastSeenAt = now();
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'welcome') {
        window.clearTimeout(welcomeTimer);
        state.clientId = message.clientId || null;
        state.connectedAt = now();
        state.retries = 0;
        state.lastError = null;
        setStatus('connected');
        startHeartbeat();
        // Confirm to DSH/console that the page is now addressable.
        emit('omni-web-mcp:ready', { clientId: state.clientId, hub: state.hub });
      } else if (message.type === 'request') {
        handleRequest(message);
      } else if (message.type === 'ping') {
        send({ v: PROTOCOL, type: 'pong', t: message.t || now() });
      } else if (message.type === 'pong') {
        // Timestamp was refreshed above; no other bookkeeping needed.
      } else if (message.type === 'error') {
        state.lastError = new Error(message.message || 'Hub error');
        if (message.code === 'UNAUTHORIZED') {
          state.unauthorized = true;
          setStatus('unauthorized', state.lastError);
        }
        updateBadge();
      }
    };

    socket.onerror = function () {
      state.lastError = new Error('Cannot reach Omni-Web-MCP hub at ' + state.hub);
    };

    socket.onclose = function (event) {
      window.clearTimeout(welcomeTimer);
      clearHeartbeat();
      if (state.socket === socket) state.socket = null;
      var wasConnected = !!state.clientId;
      state.clientId = null;
      state.connectedAt = 0;
      if (state.manualClose) return;
      if (event && event.code === 4001) {
        state.unauthorized = true;
        state.lastError = new Error(event.reason || (isZh ? '配对令牌无效' : 'Invalid pairing token'));
        setStatus('unauthorized', state.lastError);
        return;
      }
      state.lastError = state.lastError || new Error(wasConnected ? 'Hub connection lost' : 'Cannot reach hub');
      setStatus('reconnecting', state.lastError);
      scheduleReconnect();
    };
  }

  function connect() {
    state.started = true;
    state.manualClose = false;
    state.unauthorized = false;
    state.retries = 0;
    if (state.socket && state.socket.readyState === 1 && state.clientId) {
      return Promise.resolve(api);
    }
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    var promise = new Promise(function (resolve, reject) {
      state.connectWaiters.push({ resolve: resolve, reject: reject });
    });
    if (state.socket && (state.socket.readyState === 0 || state.socket.readyState === 1)) {
      return promise;
    }
    setStatus('connecting');
    discoverToken(function () {
      if (!state.manualClose) openSocket();
    });
    return promise;
  }

  function disconnect() {
    state.manualClose = true;
    state.unauthorized = false;
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    clearHeartbeat();
    var socket = state.socket;
    state.socket = null;
    state.clientId = null;
    state.connectedAt = 0;
    if (socket) {
      try { socket.close(1000, 'client disconnect'); } catch (err) { /* noop */ }
    }
    settleWaiters(false, new Error('Connection cancelled'));
    setStatus('idle');
  }

  function reconnect() {
    disconnect();
    state.manualClose = false;
    state.unauthorized = false;
    state.retries = 0;
    return connect();
  }

  /* ------------------------------------------------------------------ *
   * Remote request handling
   * ------------------------------------------------------------------ */

  function handleRequest(message) {
    var action = String(message.action || '');
    var params = message.params && typeof message.params === 'object' ? message.params : {};
    var started = now();
    var requestId = message.id;

    performAction(action, params).then(function (result) {
      send({ v: PROTOCOL, type: 'result', id: requestId, ok: true, result: result });
      emit('omni-web-mcp:action', {
        action: action,
        ok: true,
        durationMs: now() - started,
        summary: summarizeAction(action, result)
      });
    }).catch(function (err) {
      send({
        v: PROTOCOL,
        type: 'result',
        id: requestId,
        ok: false,
        error: {
          code: err && err.code ? err.code : 'CLIENT_ERROR',
          message: err && err.message ? err.message : 'Unknown page-side error'
        }
      });
      emit('omni-web-mcp:action', {
        action: action,
        ok: false,
        durationMs: now() - started,
        summary: err && err.message ? err.message : 'Action failed'
      });
    });
  }

  function summarizeAction(action, result) {
    if (!result) return action;
    if (action === 'get_dom_tree') {
      return 'captured ' + (result.interactive ? result.interactive.length : 0) + ' elements';
    }
    if (result.name) return result.name;
    if (result.page && result.page.title) return result.page.title;
    return action + ' ok';
  }

  function performAction(action, params) {
    if (action === 'get_dom_tree') return Promise.resolve(captureSnapshot(params));
    if (action === 'click_element') return clickElement(params);
    if (action === 'input_text') return inputText(params);
    if (action === 'scroll_page') return scrollPage(params);
    return Promise.reject(errorWithCode('UNKNOWN_ACTION', 'Unsupported action: ' + action));
  }

  /* ------------------------------------------------------------------ *
   * DOM model
   * ------------------------------------------------------------------ */

  var INTERACTIVE_SELECTOR = [
    'a[href]', 'area[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
    'summary', '[contenteditable="true"]', '[contenteditable=""]', '[role="button"]',
    '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="tab"]', '[role="menuitem"]', '[role="combobox"]', '[role="textbox"]',
    '[role="slider"]', '[role="option"]', 'audio[controls]', 'video[controls]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1,
    IFRAME: 1, OBJECT: 1, EMBED: 1, HEAD: 1, META: 1, LINK: 1
  };

  var STRUCTURAL_TAGS = {
    HEADER: 'banner', NAV: 'navigation', MAIN: 'main', SECTION: 'region',
    ARTICLE: 'article', ASIDE: 'complementary', FOOTER: 'contentinfo',
    FORM: 'form', DIALOG: 'dialog', DETAILS: 'group', TABLE: 'table',
    UL: 'list', OL: 'list'
  };

  function isSkippable(el) {
    if (!el || el.nodeType !== 1) return true;
    var tag = String(el.tagName || '').toUpperCase();
    if (SKIP_TAGS[tag]) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('data-omni-ignore')) return true;
    return false;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1 || isSkippable(el)) return false;
    if (el.hidden) return false;
    try {
      var style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parseFloat(style.opacity) === 0) return false;
    } catch (err) {
      return false;
    }
    try {
      return el.getClientRects().length > 0;
    } catch (err) {
      return false;
    }
  }

  function descriptorFor(el) {
    var tag = String(el.tagName || '').toLowerCase();
    var type = String(el.getAttribute('type') || '').toLowerCase();
    var role = el.getAttribute('role') || '';
    if (!role) {
      if (tag === 'a' || tag === 'area') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'summary') role = 'disclosure';
      else if (tag === 'input') {
        if (type === 'checkbox') role = 'checkbox';
        else if (type === 'radio') role = 'radio';
        else if (type === 'range') role = 'slider';
        else if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') role = 'button';
        else if (type === 'search') role = 'searchbox';
        else if (type === 'file') role = 'file-input';
        else role = 'textbox';
      } else if (el.isContentEditable) role = 'textbox';
      else if (tag === 'audio' || tag === 'video') role = 'media';
      else if (el.hasAttribute('tabindex')) role = 'group';
    }
    return { tag: tag, type: type, role: role };
  }

  function labelText(el) {
    if (!el) return '';
    try {
      if (el.labels && el.labels.length) {
        var labels = [];
        for (var i = 0; i < el.labels.length; i += 1) {
          var text = compact(el.labels[i].innerText, 80);
          if (text) labels.push(text);
        }
        if (labels.length) return labels.join(' / ');
      }
    } catch (err) { /* not a labelable element */ }
    return '';
  }

  function accessibleName(el) {
    var name = '';
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ids = labelledBy.split(/\s+/);
      var parts = [];
      for (var i = 0; i < ids.length; i += 1) {
        var labelled = document.getElementById(ids[i]);
        if (labelled) parts.push(compact(labelled.innerText || labelled.textContent, 80));
      }
      name = parts.join(' ');
    }
    if (!name) name = el.getAttribute('aria-label') || '';
    if (!name) name = labelText(el);
    if (!name && el.tagName === 'IMG') name = el.getAttribute('alt') || '';
    if (!name) name = el.getAttribute('title') || '';
    if (!name) {
      var tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        var type = String(el.getAttribute('type') || '').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset') name = el.value || type;
        else name = el.getAttribute('placeholder') || '';
      }
    }
    if (!name) {
      var role = descriptorFor(el).role;
      if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' ||
          role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'option' ||
          el.tagName === 'SUMMARY') {
        name = el.innerText || el.textContent || '';
      }
    }
    if (!name) name = el.getAttribute('name') || el.id || '';
    return compact(name, MAX_NAME_CHARS);
  }

  function sensitiveElement(el) {
    if (!el) return false;
    if (String(el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    if (config.privacy === 'strict') return true;
    var haystack = [
      el.getAttribute('type'), el.getAttribute('name'), el.id,
      el.getAttribute('autocomplete'), el.getAttribute('placeholder'),
      el.getAttribute('aria-label')
    ].join(' ');
    return /password|passwd|pwd|secret|token|otp|one[-_ ]?time|cvv|cvc|ssn|social[-_ ]?security|credit[-_ ]?card|card[-_ ]?number/i.test(haystack);
  }

  function elementValue(el) {
    if (!el) return undefined;
    var tag = String(el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return undefined;
    var inputType = String(el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio' || inputType === 'button' || inputType === 'submit' || inputType === 'image' || inputType === 'reset' || inputType === 'file')) {
      return undefined;
    }
    if (sensitiveElement(el)) return '\u2022\u2022\u2022\u2022';
    var value = '';
    try { value = el.value; } catch (err) { return undefined; }
    if (value === null || value === undefined || value === '') return undefined;
    return compact(value, MAX_VALUE_CHARS);
  }

  function rectOf(el) {
    try {
      var rect = el.getBoundingClientRect();
      return [
        Math.round(rect.left + (window.pageXOffset || 0)),
        Math.round(rect.top + (window.pageYOffset || 0)),
        Math.round(rect.width),
        Math.round(rect.height)
      ];
    } catch (err) {
      return [0, 0, 0, 0];
    }
  }

  function hrefOf(el) {
    if (String(el.tagName || '').toLowerCase() !== 'a') return undefined;
    var raw = el.getAttribute('href') || '';
    if (!raw || /^javascript:/i.test(raw) || /^data:/i.test(raw)) return undefined;
    try {
      var u = new window.URL(raw, window.location.href);
      return compact(u.pathname + u.search + u.hash, 180);
    } catch (err) {
      return compact(raw, 180);
    }
  }

  function elementId(el) {
    if (elementIds) {
      var cached = elementIds.get(el);
      if (cached) return cached;
    }
    idCounter += 1;
    var id = String(idCounter);
    idElements[id] = el;
    if (elementIds) elementIds.set(el, id);
    return id;
  }

  function resolveElement(rawId) {
    if (rawId === null || rawId === undefined || rawId === '') {
      throw errorWithCode('INVALID_ARGS', 'An element id is required. Call get_dom_tree first.');
    }
    var id = String(rawId).trim().replace(/^[\[#]+/, '').replace(/[\]]+$/, '').replace(/^e/i, '');
    if (!/^\d+$/.test(id)) {
      throw errorWithCode('INVALID_ID', 'Invalid element id "' + rawId + '". Use an id from get_dom_tree.');
    }
    var el = idElements[id];
    if (!el) {
      throw errorWithCode('STALE_ID', 'Element ' + rawId + ' is no longer known. Refresh with get_dom_tree.');
    }
    if (!document.documentElement.contains(el)) {
      delete idElements[id];
      throw errorWithCode('STALE_ID', 'Element ' + rawId + ' left the document. Refresh with get_dom_tree.');
    }
    return el;
  }

  function interactiveEntry(el) {
    var descriptor = descriptorFor(el);
    var entry = {
      id: elementId(el),
      tag: descriptor.tag,
      role: descriptor.role,
      name: accessibleName(el)
    };
    if (descriptor.type) entry.type = descriptor.type;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') entry.disabled = true;
    if (typeof el.checked === 'boolean') entry.checked = el.checked;
    if (el.readOnly) entry.readonly = true;
    if (el.required) entry.required = true;
    var value = elementValue(el);
    if (value !== undefined) entry.value = value;
    if (sensitiveElement(el) && descriptor.type !== 'checkbox' && descriptor.type !== 'radio') {
      entry.sensitive = true;
    }
    if (descriptor.role === 'combobox' && el.tagName === 'SELECT') {
      entry.options = [];
      var ops = el.options || [];
      for (var i = 0; i < ops.length && i < 12; i += 1) {
        entry.options.push(compact(ops[i].text, 80));
      }
      if (ops.length > 12) entry.options.push('... ' + (ops.length - 12) + ' more');
    }
    var expanded = el.getAttribute('aria-expanded');
    if (expanded !== null) entry.expanded = expanded === 'true';
    var pressed = el.getAttribute('aria-pressed');
    if (pressed !== null) entry.pressed = pressed === 'true';
    var href = hrefOf(el);
    if (href) entry.href = href;
    entry.box = rectOf(el);
    return entry;
  }

  function captureInteractive(limit, root) {
    var candidates;
    try {
      candidates = (root || document).querySelectorAll(INTERACTIVE_SELECTOR);
    } catch (err) {
      throw errorWithCode('INVALID_SELECTOR', 'The page selector could not be evaluated.');
    }
    var entries = [];
    var seen = Object.create(null);
    for (var i = 0; i < candidates.length; i += 1) {
      if (entries.length >= limit) break;
      var el = candidates[i];
      if (el.closest && el.closest('[data-omni-ignore]')) continue;
      if (!isVisible(el)) continue;
      var key = elementId(el);
      if (seen[key]) continue;
      seen[key] = true;
      entries.push(interactiveEntry(el));
    }
    return entries;
  }

  function captureText(maxChars) {
    var body = document.body;
    if (!body) return { text: '', truncated: false };
    var raw = '';
    try { raw = body.innerText || body.textContent || ''; } catch (err) { raw = body.textContent || ''; }
    var lines = raw.replace(/\r\n?/g, '\n').split('\n');
    var output = [];
    var total = 0;
    var previous = null;
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (!line) {
        if (output.length && output[output.length - 1] !== '') output.push('');
        continue;
      }
      if (line === previous) continue;
      previous = line;
      if (line.length > 320) line = line.slice(0, 319) + '\u2026';
      if (total + line.length + 1 > maxChars) {
        output.push('\u2026 (text truncated)');
        return { text: output.join('\n').trim(), truncated: true };
      }
      output.push(line);
      total += line.length + 1;
    }
    return { text: output.join('\n').trim(), truncated: false };
  }

  function outlineName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return compact(aria, 80);
    if (/^H[1-6]$/.test(el.tagName)) {
      var heading = compact(el.innerText || el.textContent, 90);
      if (heading) return heading;
    }
    if (el.tagName === 'FORM' || el.tagName === 'SECTION') {
      return compact(el.getAttribute('aria-label') || el.getAttribute('name') || '', 80);
    }
    return '';
  }

  function captureOutline() {
    if (!document.body) return [];
    var lines = [{ depth: 0, tag: 'body', role: 'document', name: compact(document.title, 90) }];
    var count = 0;
    var visits = 0;

    function walk(parent, depth) {
      if (!parent || count >= 140 || visits >= 1200 || depth > 14) return;
      var children = parent.children || [];
      for (var i = 0; i < children.length; i += 1) {
        if (count >= 140 || visits >= 1200) return;
        visits += 1;
        var el = children[i];
        if (isSkippable(el) || !isVisible(el)) continue;
        var tag = String(el.tagName || '').toUpperCase();
        var role = STRUCTURAL_TAGS[tag] || '';
        var id = null;
        if (elementIds) id = elementIds.get(el) || null;
        var heading = /^H[1-6]$/.test(tag);
        var isStructural = !!role;
        if (isStructural || heading || id) {
          lines.push({
            depth: depth,
            tag: tag.toLowerCase(),
            role: role || descriptorFor(el).role,
            name: heading || role ? outlineName(el) : compact(accessibleName(el), 80),
            id: id || undefined
          });
          count += 1;
          walk(el, depth + 1);
        } else {
          walk(el, depth);
        }
      }
    }

    walk(document.body, 1);
    return lines;
  }

  function renderSnapshot(data) {
    var out = [];
    out.push('# ' + (data.page.title || '(untitled page)'));
    out.push('URL: ' + data.page.url);
    out.push('VIEWPORT: ' + data.viewport.width + 'x' + data.viewport.height +
      ' · scroll ' + data.viewport.scrollY + '/' + Math.max(0, data.viewport.scrollHeight - data.viewport.height));
    out.push('');
    if (data.outline && data.outline.length) {
      out.push('## STRUCTURE');
      for (var i = 0; i < data.outline.length; i += 1) {
        var node = data.outline[i];
        var indent = new Array(node.depth + 1).join('  ');
        var label = node.name ? ' "' + node.name + '"' : '';
        var nodeId = node.id ? ' [' + node.id + ']' : '';
        out.push(indent + '<' + node.tag + '>' + nodeId + label);
      }
      out.push('');
    }
    out.push('## INTERACTIVE (' + data.interactive.length + ')');
    if (!data.interactive.length) out.push('(none found)');
    for (var j = 0; j < data.interactive.length; j += 1) {
      var item = data.interactive[j];
      var line = '[' + item.id + '] ' + item.role + ' "' + (item.name || '(unnamed)') + '"';
      var flags = [];
      if (item.disabled) flags.push('disabled');
      if (item.readonly) flags.push('readonly');
      if (item.required) flags.push('required');
      if (typeof item.checked === 'boolean') flags.push(item.checked ? 'checked' : 'unchecked');
      if (typeof item.expanded === 'boolean') flags.push(item.expanded ? 'expanded' : 'collapsed');
      if (item.value !== undefined) flags.push('value="' + item.value + '"');
      if (item.options && item.options.length) flags.push('options=[' + item.options.join(' | ') + ']');
      if (item.href) flags.push('href=' + item.href);
      if (flags.length) line += ' · ' + flags.join(', ');
      out.push(line);
    }
    if (data.text) {
      out.push('');
      out.push('## TEXT');
      out.push(data.text);
    }
    if (data.truncated && (data.truncated.text || data.truncated.elements || data.truncated.outline)) {
      out.push('');
      out.push('(snapshot truncated to keep context light)');
    }
    return out.join('\n');
  }

  function captureSnapshot(params) {
    var options = params && typeof params === 'object' ? params : {};
    var maxChars = clampInt(options.max_text_chars, 300, 20000, TEXT_LIMIT);
    var maxElements = clampInt(options.max_elements, 1, 300, ELEMENT_LIMIT);
    var includeText = options.include_text !== false;
    var selector = options.selector ? String(options.selector) : '';
    var root = document;
    if (selector) {
      try {
        root = document.querySelector(selector);
      } catch (err) {
        throw errorWithCode('INVALID_SELECTOR', 'Invalid selector: ' + selector);
      }
      if (!root) {
        throw errorWithCode('NO_MATCH', 'No element matches selector: ' + selector);
      }
    }

    var interactiveAll = [];
    if (root === document) {
      interactiveAll = captureInteractive(maxElements, document);
    } else {
      if (isSkippable(root)) {
        throw errorWithCode('NOT_VISIBLE', 'The selected element is hidden.');
      }
      if (isVisible(root) && root.matches && root.matches(INTERACTIVE_SELECTOR)) {
        interactiveAll.push(interactiveEntry(root));
      }
      var descendants = captureInteractive(maxElements - interactiveAll.length, root);
      interactiveAll = interactiveAll.concat(descendants);
    }

    var textResult = includeText ? captureText(maxChars) : { text: '', truncated: false };
    var outline = [];
    if (includeText) {
      try { outline = captureOutline(); } catch (err) { outline = []; }
      if (outline.length > 140) outline = outline.slice(0, 140);
    }

    var data = {
      v: 1,
      page: {
        url: window.location.href,
        title: document.title,
        lang: document.documentElement.lang || '',
        referrer: document.referrer || ''
      },
      viewport: {
        width: window.innerWidth || document.documentElement.clientWidth || 0,
        height: window.innerHeight || document.documentElement.clientHeight || 0,
        scrollX: Math.round(window.pageXOffset || 0),
        scrollY: Math.round(window.pageYOffset || 0),
        scrollWidth: Math.max(document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth : 0),
        scrollHeight: Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0),
        devicePixelRatio: window.devicePixelRatio || 1
      },
      text: textResult.text,
      outline: outline,
      interactive: interactiveAll,
      truncated: {
        text: textResult.truncated,
        elements: interactiveAll.length >= maxElements,
        outline: outline.length >= 140
      },
      capturedAt: new Date().toISOString()
    };
    data.rendered = renderSnapshot(data);
    data.renderedChars = data.rendered.length;
    return data;
  }

  function clampInt(value, min, max, fallback) {
    var number = parseInt(value, 10);
    if (!isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  function pageSummary() {
    return { url: window.location.href, title: document.title };
  }

  function clickElement(params) {
    var el;
    try {
      el = resolveElement(params && (params.id !== undefined ? params.id : params.element_id));
    } catch (err) {
      return Promise.reject(err);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      return Promise.reject(errorWithCode('DISABLED', 'Element ' + params.id + ' is disabled.'));
    }
    if (!isVisible(el)) {
      return Promise.reject(errorWithCode('NOT_VISIBLE', 'Element ' + params.id + ' is not visible.'));
    }

    var beforeUrl = window.location.href;
    var info = interactiveEntry(el);
    try {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    } catch (err) {
      try { el.scrollIntoView(); } catch (err2) { /* noop */ }
    }
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch (err) {
      try { el.focus(); } catch (err2) { /* noop */ }
    }

    try {
      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new window.MouseEvent('click', {
          bubbles: true, cancelable: true, view: window, button: 0
        }));
      }
    } catch (err) {
      return Promise.reject(errorWithCode('CLICK_FAILED', 'Could not click element ' + params.id + ': ' + err.message));
    }

    return delay(160).then(function () {
      return {
        ok: true,
        action: 'click_element',
        id: info.id,
        tag: info.tag,
        role: info.role,
        name: info.name,
        navigated: window.location.href !== beforeUrl,
        mayNavigate: !!info.href,
        page: pageSummary(),
        viewport: { scrollY: Math.round(window.pageYOffset || 0) }
      };
    });
  }

  function setNativeValue(el, value) {
    var tag = String(el.tagName || '').toLowerCase();
    var proto = null;
    if (tag === 'textarea') proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    else if (tag === 'select') proto = window.HTMLSelectElement && window.HTMLSelectElement.prototype;
    else proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    var descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  }

  function dispatchInput(el, text) {
    var inputEvent;
    try {
      inputEvent = new window.InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertText',
        data: text
      });
    } catch (err) {
      inputEvent = new window.Event('input', { bubbles: true, cancelable: false });
    }
    el.dispatchEvent(inputEvent);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  }

  function submitFormOf(el, text) {
    var form = el.form;
    if (!form || form.noValidate === undefined) return false;
    var keyDown = new window.KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    });
    var notCancelled = el.dispatchEvent(keyDown);
    el.dispatchEvent(new window.KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
    if (!notCancelled) return false;
    window.setTimeout(function () {
      try {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } catch (err) { /* validation or navigation is app-owned */ }
    }, 0);
    return true;
  }

  function inputText(params) {
    var el;
    try {
      el = resolveElement(params && (params.id !== undefined ? params.id : params.element_id));
    } catch (err) {
      return Promise.reject(err);
    }
    if (params.text === undefined || params.text === null) {
      return Promise.reject(errorWithCode('INVALID_ARGS', 'input_text requires a "text" string.'));
    }
    var text = String(params.text);
    if (text.length > 100000) text = text.slice(0, 100000);
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') {
      return Promise.reject(errorWithCode('DISABLED', 'Element ' + params.id + ' is not editable.'));
    }
    if (!isVisible(el)) {
      return Promise.reject(errorWithCode('NOT_VISIBLE', 'Element ' + params.id + ' is not visible.'));
    }

    var tag = String(el.tagName || '').toLowerCase();
    var type = String(el.getAttribute('type') || '').toLowerCase();
    var sensitive = sensitiveElement(el);
    var info = interactiveEntry(el);
    var beforeUrl = window.location.href;
    var submitted = false;
    var optionMatched = false;

    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: false });
      if (tag === 'select') {
        var options = el.options || [];
        var wanted = text.toLowerCase();
        for (var i = 0; i < options.length; i += 1) {
          if (String(options[i].value).toLowerCase() === wanted ||
              compact(options[i].text, 300).toLowerCase() === wanted) {
            el.selectedIndex = i;
            optionMatched = true;
            break;
          }
        }
        if (!optionMatched) {
          return Promise.reject(errorWithCode('NO_OPTION', 'No option matches "' + compact(text, 100) + '" in element ' + params.id + '.'));
        }
        el.dispatchEvent(new window.Event('input', { bubbles: true }));
        el.dispatchEvent(new window.Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        var selection = window.getSelection && window.getSelection();
        if (selection && document.createRange) {
          var range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        var inserted = false;
        try {
          inserted = document.execCommand && document.execCommand('insertText', false, text);
        } catch (err) { inserted = false; }
        if (!inserted) el.textContent = text;
        dispatchInput(el, text);
      } else if (tag === 'input' || tag === 'textarea') {
        if (type === 'checkbox' || type === 'radio' || type === 'file' || type === 'range') {
          return Promise.reject(errorWithCode('UNSUPPORTED_INPUT', 'Element ' + params.id + ' is a ' + type +
            ' input. Use click_element for toggles and controls.'));
        }
        setNativeValue(el, text);
        dispatchInput(el, text);
      } else {
        return Promise.reject(errorWithCode('NOT_EDITABLE', 'Element ' + params.id + ' is not an input, textarea, select or editable region.'));
      }
      if (params.submit === true) submitted = submitFormOf(el, text);
    } catch (err) {
      return Promise.reject(errorWithCode('INPUT_FAILED', 'Could not enter text into element ' + params.id + ': ' + err.message));
    }

    return delay(120).then(function () {
      return {
        ok: true,
        action: 'input_text',
        id: info.id,
        tag: info.tag,
        role: info.role,
        name: info.name,
        chars: text.length,
        sensitive: sensitive,
        submitted: submitted,
        navigated: window.location.href !== beforeUrl,
        page: pageSummary()
      };
    });
  }

  function scrollPage(params) {
    var options = params && typeof params === 'object' ? params : {};
    var direction = String(options.direction || 'down').toLowerCase();
    var amount = parseInt(options.amount, 10);
    if (!isFinite(amount) || amount <= 0) {
      amount = Math.max(240, Math.round((window.innerHeight || 800) * 0.82));
    }
    amount = Math.min(amount, 100000);

    var target = window;
    var targetEl = null;
    if (options.id !== undefined && options.id !== null) {
      try {
        targetEl = resolveElement(options.id);
      } catch (err) {
        return Promise.reject(err);
      }
      target = targetEl;
    }

    var before = targetEl
      ? { top: targetEl.scrollTop, left: targetEl.scrollLeft }
      : { top: window.pageYOffset || 0, left: window.pageXOffset || 0 };

    try {
      if (direction === 'top') {
        if (targetEl) targetEl.scrollTo({ top: 0, behavior: 'auto' });
        else window.scrollTo(0, 0);
      } else if (direction === 'bottom') {
        if (targetEl) targetEl.scrollTo({ top: targetEl.scrollHeight, behavior: 'auto' });
        else window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
      } else if (direction === 'up') {
        if (targetEl) targetEl.scrollBy({ top: -amount, left: 0, behavior: 'auto' });
        else window.scrollBy(0, -amount);
      } else if (direction === 'down') {
        if (targetEl) targetEl.scrollBy({ top: amount, left: 0, behavior: 'auto' });
        else window.scrollBy(0, amount);
      } else if (direction === 'left') {
        if (targetEl) targetEl.scrollBy({ left: -amount, top: 0, behavior: 'auto' });
        else window.scrollBy(-amount, 0);
      } else if (direction === 'right') {
        if (targetEl) targetEl.scrollBy({ left: amount, top: 0, behavior: 'auto' });
        else window.scrollBy(amount, 0);
      } else {
        return Promise.reject(errorWithCode('INVALID_ARGS', 'direction must be one of: up, down, top, bottom, left, right.'));
      }
    } catch (err) {
      return Promise.reject(errorWithCode('SCROLL_FAILED', 'Could not scroll: ' + err.message));
    }

    return delay(140).then(function () {
      if (targetEl) {
        return {
          ok: true,
          action: 'scroll_page',
          direction: direction,
          target: options.id,
          scrollTop: Math.round(targetEl.scrollTop),
          scrollHeight: Math.round(targetEl.scrollHeight),
          viewportHeight: Math.round(targetEl.clientHeight),
          delta: Math.round(targetEl.scrollTop - before.top)
        };
      }
      var scrollY = Math.round(window.pageYOffset || 0);
      var scrollHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      var viewportHeight = window.innerHeight || 0;
      return {
        ok: true,
        action: 'scroll_page',
        direction: direction,
        scrollY: scrollY,
        scrollHeight: scrollHeight,
        viewportHeight: viewportHeight,
        atBottom: scrollY + viewportHeight >= scrollHeight - 2,
        delta: scrollY - Math.round(before.top)
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * Status badge (Shadow DOM — never leaks styles into the host page)
   * ------------------------------------------------------------------ */

  var BADGE_CSS = [
    '.wrap{position:relative;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.pill{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;margin:0;border:1px solid rgba(255,255,255,.14);',
    'border-radius:999px;background:rgba(10,14,22,.84);color:#e8eef8;font:600 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;',
    'letter-spacing:.1em;text-transform:uppercase;cursor:pointer;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);',
    'box-shadow:0 8px 30px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.06);transition:border-color .2s,transform .2s}',
    '.pill:hover{border-color:rgba(255,255,255,.26);transform:translateY(-1px)}',
    '.pill:focus-visible{outline:2px solid #8ec5ff;outline-offset:2px}',
    '.dot{width:6px;height:6px;border-radius:50%;background:#8b95a7;box-shadow:0 0 0 3px rgba(139,149,167,.1);flex:none}',
    '.s-connecting .dot,.s-reconnecting .dot{background:#f5c451;box-shadow:0 0 0 3px rgba(245,196,81,.12);animation:pulse 1.2s infinite}',
    '.s-connected .dot{background:#4ee5a3;box-shadow:0 0 0 3px rgba(78,229,163,.14),0 0 10px rgba(78,229,163,.65)}',
    '.s-unauthorized .dot,.s-offline .dot,.s-error .dot{background:#ff6b7a;box-shadow:0 0 0 3px rgba(255,107,122,.12)}',
    '.s-idle .dot{background:#8b95a7}',
    '.brand{color:#fff}',
    '.state{color:#8f9bad;letter-spacing:.06em}',
    '.chev{color:#657084;font-size:9px;transition:transform .2s}',
    '.open .chev{transform:rotate(180deg)}',
    '.panel{position:absolute;right:0;bottom:44px;width:254px;padding:14px;border:1px solid rgba(255,255,255,.12);',
    'border-radius:14px;background:rgba(12,16,25,.96);color:#dfe7f2;box-shadow:0 20px 60px rgba(0,0,0,.55);',
    'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);display:none}',
    '.panel.open{display:block;animation:rise .16s ease-out}',
    '.panel h4{margin:0 0 3px;font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#fff;letter-spacing:0}',
    '.panel p{margin:0 0 10px;color:#7e899b;font:400 10px/1.5 ui-monospace,Consolas,monospace;word-break:break-all}',
    '.row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid rgba(255,255,255,.07);',
    'font:400 10px/1.4 ui-monospace,Consolas,monospace;color:#8b97a9}',
    '.row b{color:#cfd8e5;font-weight:500;text-align:right;word-break:break-all}',
    '.actions{display:flex;gap:7px;margin-top:11px}',
    '.btn{all:unset;flex:1;text-align:center;padding:7px 8px;border-radius:7px;background:#e9f1ff;color:#0b1220;',
    'font:600 10px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer}',
    '.btn:hover{background:#fff}',
    '.btn.ghost{background:rgba(255,255,255,.07);color:#c9d3e0}',
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}'
  ].join('');

  function badgeStrings() {
    return isZh ? {
      idle: '待连接', connecting: '连接中', reconnecting: '重连中', connected: '在线',
      unauthorized: '待配对', offline: '离线', unsupported: '不支持', error: '异常',
      title: 'Omni-Web-MCP', description: '把当前页面交给 AI 操作',
      hub: '中转', client: '页面 ID', reconnect: '重新连接', copy: '复制 Hub 地址'
    } : {
      idle: 'idle', connecting: 'linking', reconnecting: 'retrying', connected: 'live',
      unauthorized: 'pairing', offline: 'offline', unsupported: 'unsupported', error: 'error',
      title: 'Omni-Web-MCP', description: 'This page is an AI-operable surface',
      hub: 'hub', client: 'page id', reconnect: 'Reconnect', copy: 'Copy hub URL'
    };
  }

  function updateBadge() {
    if (!state.badge || !state.badgePanel) return;
    var strings = badgeStrings();
    var root = state.badge;
    var statusClass = 's-' + state.status;
    var kept = [];
    var classes = String(root.className || '').split(/\s+/);
    for (var i = 0; i < classes.length; i += 1) {
      if (classes[i] && classes[i].indexOf('s-') !== 0 && classes[i] !== 'wrap') kept.push(classes[i]);
    }
    root.className = 'wrap ' + statusClass + (kept.length ? ' ' + kept.join(' ') : '');
    root.setAttribute('data-status', state.status);
    var stateEl = root.querySelector('.state');
    if (stateEl) stateEl.textContent = strings[state.status] || state.status;
    var clientEl = root.querySelector('[data-field="client"]');
    if (clientEl) clientEl.textContent = state.clientId || '—';
    var hubEl = root.querySelector('[data-field="hub"]');
    if (hubEl) hubEl.textContent = state.hub;
    var errEl = root.querySelector('[data-field="error"]');
    if (errEl) {
      if (state.lastError) {
        errEl.style.display = 'block';
        errEl.textContent = state.lastError.message;
      } else {
        errEl.style.display = 'none';
        errEl.textContent = '';
      }
    }
  }

  function copyText(text, callback) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { callback(true); }, function () { callback(false); });
        return;
      }
    } catch (err) { /* fall through */ }
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      callback(ok);
    } catch (err) {
      callback(false);
    }
  }

  function createBadge() {
    if (!config.badge || state.badge || !document.body) return;
    var strings = badgeStrings();
    var host = document.createElement('div');
    host.setAttribute('data-omni-web-mcp-badge', '');
    var position = config.badgePosition;
    var cssPos = 'right:18px;bottom:18px';
    if (position === 'bottom-left') cssPos = 'left:18px;bottom:18px';
    else if (position === 'bottom-center') cssPos = 'left:50%;bottom:18px;transform:translateX(-50%)';
    host.style.cssText = 'position:fixed;z-index:2147483647;' + cssPos + ';';
    document.body.appendChild(host);

    var shadow;
    try {
      shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    } catch (err) {
      shadow = host;
    }
    var style = document.createElement('style');
    style.textContent = BADGE_CSS;
    shadow.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'pill';
    button.setAttribute('aria-label', strings.title + ' — ' + strings.description);
    button.innerHTML = '<span class="dot" aria-hidden="true"></span>' +
      '<span class="brand">MCP</span>' +
      '<span class="state">' + (strings[state.status] || state.status) + '</span>' +
      '<span class="chev" aria-hidden="true">▾</span>';

    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<h4>' + strings.title + ' <span style="color:#687386;font-weight:400">v' + VERSION + '</span></h4>' +
      '<p>' + strings.description + '</p>' +
      '<div class="row"><span>' + strings.hub + '</span><b data-field="hub"></b></div>' +
      '<div class="row"><span>' + strings.client + '</span><b data-field="client">—</b></div>' +
      '<div class="row" data-field="error" style="display:none;color:#ff9aa5"></div>' +
      '<div class="actions">' +
        '<button type="button" class="btn" data-action="reconnect">' + strings.reconnect + '</button>' +
        '<button type="button" class="btn ghost" data-action="copy">' + strings.copy + '</button>' +
      '</div>';

    wrap.appendChild(button);
    wrap.appendChild(panel);
    shadow.appendChild(wrap);

    button.addEventListener('click', function () {
      panel.classList.toggle('open');
      button.classList.toggle('open');
    });
    panel.addEventListener('click', function (event) {
      var actionEl = event.target.closest ? event.target.closest('[data-action]') : null;
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-action');
      if (action === 'reconnect') {
        reconnect();
        panel.classList.remove('open');
        button.classList.remove('open');
      } else if (action === 'copy') {
        copyText(state.hub, function (ok) {
          actionEl.textContent = ok ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制失败' : 'Copy failed');
          window.setTimeout(function () {
            actionEl.textContent = strings.copy;
          }, 1600);
        });
      }
    });

    state.badge = wrap;
    state.badgePanel = panel;
    state.badgeButton = button;
    updateBadge();
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  var api = {
    version: VERSION,
    protocol: PROTOCOL,
    config: config,
    connect: connect,
    disconnect: disconnect,
    reconnect: reconnect,
    getState: function () {
      return {
        status: state.status,
        clientId: state.clientId,
        hub: state.hub,
        connectedAt: state.connectedAt,
        lastError: state.lastError ? state.lastError.message : null
      };
    },
    snapshot: function (options) { return captureSnapshot(options || {}); },
    getDomTree: function (options) { return captureSnapshot(options || {}); },
    click: function (id) { return clickElement({ id: id }); },
    clickElement: clickElement,
    input: function (id, text, submit) { return inputText({ id: id, text: text, submit: submit === true }); },
    inputText: inputText,
    scroll: function (direction, amount) { return scrollPage({ direction: direction, amount: amount }); },
    scrollPage: scrollPage,
    __omniLoaded: true
  };

  window.OmniWebMCP = api;

  // Short alias for console users.
  if (!window.omni) window.omni = api;

  function start() {
    if (state.started) return;
    state.started = true;
    createBadge();
    if (config.autoConnect) connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(window, document);
