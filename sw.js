/* זיכרון - service worker: offline reading.
   - App shell: stale-while-revalidate, cache named with VERSION (bump on EVERY deploy, together with ?v= in index.html).
   - API GETs: network first, cache when offline. Images: cache first, keyed on path + v only.
   - Per-user caches (zk-api-u<id>-v<N>, zk-img-u<id>-v<N>). The page tells us the user id; we never see or store tokens.
   - Never cached: anything not GET, /auth/login, /auth/register, /invites/*, /app-error, /memorials/<slug>/admin (holds the invite token). */
"use strict";

var VERSION = "2026-10-29-1";          // must change on every deploy (index.html uses ?v=<VERSION>)
var DATA_VERSION = 1;                   // bump only if the cached API/image format changes
var DEFAULT_API = "https://31-97-114-221.sslip.io/yoyo-memory-api";
var SHELL_CACHE = "zk-shell-" + VERSION;
var PUBLIC_CACHE = "zk-pub-v" + DATA_VERSION;
var META_CACHE = "zk-meta";
var META_KEY = "/__zk/meta";
var IMG_MAX_ENTRIES = 300;
var IMG_MAX_BYTES = 150 * 1024 * 1024;
var SHELL_FILES = ["/index.html", "/app.js?v=" + VERSION, "/style.css?v=" + VERSION, "/config.js?v=" + VERSION, "/favicon.svg"];

// ------------------------------------------------------------ pure helpers (unit-tested with node)
function apiCacheName(uid) { return "zk-api-u" + uid + "-v" + DATA_VERSION; }
function imgCacheName(uid) { return "zk-img-u" + uid + "-v" + DATA_VERSION; }
function validUid(uid) { return typeof uid === "number" && isFinite(uid) && uid > 0 && Math.floor(uid) === uid; }

// Signed media URLs change on every load; keep only the path and the variant (drop u, e, s and anything else).
function mediaCacheKey(url) {
  var u = new URL(url);
  var v = u.searchParams.get("v");
  return u.origin + u.pathname + (v === "full" || v === "thumb" ? "?v=" + v : "");
}

// What to do with a request: "shell" | "api" | "public" | "media" | null (= don't touch, plain network).
function classify(method, url, api, mode, selfOrigin) {
  if (method !== "GET") return null;
  var u = new URL(url);
  if (mode === "navigate") return u.origin === selfOrigin && !/\.(js|css|svg|json|txt|png|jpe?g)$/.test(u.pathname) ? "shell" : null;
  if (u.origin === selfOrigin) {
    var p = u.pathname === "/" ? "/index.html" : u.pathname;
    return /^\/(index\.html|404\.html|app\.js|style\.css|config\.js|favicon\.svg)$/.test(p) ? "shell" : null;
  }
  var base = new URL(api);
  var prefix = base.pathname.replace(/\/+$/, "");
  if (u.origin !== base.origin || u.pathname.indexOf(prefix + "/") !== 0) return null;
  var path = u.pathname.slice(prefix.length);
  if (/^\/media\/\d+$/.test(path)) return "media";
  if (path === "/app-config.json") return "public";
  if (/^\/(auth\/(login|register|logout)|invites\/|app-error|healthz)/.test(path)) return null;
  if (/^\/memorials\/[\w-]+\/admin$/.test(path)) return null;   // contains the invite token
  if (/^\/(auth\/me|memorials)(\/|$)/.test(path)) return "api";
  return null;
}

// Cache key for an API GET: the URL only. Request headers (the bearer token) are never part of a key or stored.
function apiCacheKey(url) { var u = new URL(url); u.hash = ""; return u.href; }

// ------------------------------------------------------------ runtime
var api = DEFAULT_API;
try {
  var q = new URL(self.location.href).searchParams.get("api");
  if (q && /^https?:\/\//.test(q)) api = q.replace(/\/+$/, "");
} catch (e) {}

function shellKey(url) {
  var u = new URL(url);
  var p = u.pathname === "/" || u.pathname === "/404.html" ? "/index.html" : u.pathname;
  return p === "/index.html" || p === "/favicon.svg" ? p : p + u.search;
}

var metaPromise = null;
function getMeta() {
  if (!metaPromise) {
    metaPromise = caches.open(META_CACHE).then(function (c) { return c.match(META_KEY); })
      .then(function (r) { return r ? r.json() : {}; }).catch(function () { return {}; });
  }
  return metaPromise;
}
function setMeta(m) {
  metaPromise = Promise.resolve(m);
  return caches.open(META_CACHE).then(function (c) {
    return c.put(META_KEY, new Response(JSON.stringify(m), { headers: { "Content-Type": "application/json" } }));
  });
}
function isUserCache(name) { return /^zk-(api|img)-u\d+-v\d+$/.test(name); }

// Delete user data caches. keepUid: keep that user's caches (null = delete all).
function deleteUserCaches(keepUid) {
  return caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) {
      return isUserCache(n) && !(validUid(keepUid) && (n === apiCacheName(keepUid) || n === imgCacheName(keepUid)));
    }).map(function (n) { return caches.delete(n); }));
  });
}
function setUser(uid) {
  uid = validUid(uid) ? uid : null;
  metaPromise = Promise.resolve({ uid: uid });  // takes effect for the very next fetch event
  return deleteUserCaches(uid).then(function () { return setMeta({ uid: uid }); });
}
// User switches run strictly one after another, in the order the page sent them.
var userQueue = Promise.resolve();
function queueUser(uid) {
  userQueue = userQueue.catch(function () {}).then(function () { return setUser(uid); });
  return userQueue;
}

// Copy a response into a plain one (no URL, no extra state) so nothing from the request is stored.
function storable(res, extra) {
  return res.clone().blob().then(function (b) {
    var h = new Headers();
    var ct = res.headers.get("Content-Type");
    if (ct) h.set("Content-Type", ct);
    h.set("X-Zk-Bytes", String(b.size));
    h.set("X-Zk-Time", String(Date.now()));
    h.set("Access-Control-Expose-Headers", "X-Zk-Time");   // lets the page tell "served from cache"
    for (var k in extra || {}) h.set(k, extra[k]);
    return new Response(b, { status: res.status, statusText: res.statusText, headers: h });
  });
}

// ---- shell: stale-while-revalidate
function handleShell(event) {
  var key = event.request.mode === "navigate" ? "/index.html" : shellKey(event.request.url);
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(key).then(function (hit) {
      var refresh = fetch(new Request(key, { cache: "no-cache" })).then(function (res) {
        if (res && res.ok && res.type === "basic") return cache.put(key, res.clone()).then(function () { return res; });
        return res;
      });
      if (hit) { event.waitUntil(refresh.catch(function () {})); return hit; }
      return refresh;
    });
  });
}

// ---- API GETs: network first, cache fallback, per user
function handleApi(event, kind) {
  var req = event.request, key = apiCacheKey(req.url);
  return getMeta().then(function (meta) {
    var uid = meta.uid;
    var name = kind === "public" ? PUBLIC_CACHE : (validUid(uid) ? apiCacheName(uid) : null);
    var fromCache = function () {
      if (!name) return Promise.resolve(null);
      return caches.open(name).then(function (c) { return c.match(key, { ignoreVary: true }); });
    };
    return fetch(req).then(function (res) {
      if (res.status === 401 && kind === "api") {
        event.waitUntil(queueUser(null));       // expired or revoked token: drop this user's offline copy
      } else if (res.ok && name) {
        event.waitUntil(getMeta().then(function (m) {
          // Store only if the same user is still current (no login/logout happened meanwhile).
          if (kind === "api" && m.uid !== uid) return;
          return storable(res).then(function (s) { return caches.open(name).then(function (c) { return c.put(key, s); }); });
        }).catch(function () {}));
      }
      return res;
    }, function (err) {
      return fromCache().then(function (hit) {
        if (hit) return hit;
        throw err;                               // nothing cached: the page sees a network error
      });
    });
  });
}

// ---- images: cache first, key = path + v
function handleMedia(event) {
  var key = mediaCacheKey(event.request.url);
  return getMeta().then(function (meta) {
    var uid = meta.uid;
    if (!validUid(uid)) return fetch(event.request);
    var name = imgCacheName(uid);
    return caches.open(name).then(function (cache) {
      return cache.match(key, { ignoreVary: true }).then(function (hit) {
        if (hit) return hit;
        // CORS fetch so the response is readable (sizes known, no opaque-response quota padding).
        return fetch(event.request.url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (res) {
          if (res.ok && (res.headers.get("Content-Type") || "").indexOf("image/") === 0) {
            event.waitUntil(getMeta().then(function (m) {
              if (m.uid !== uid) return;
              return storable(res).then(function (s) { return cache.put(key, s); }).then(function () { return trimImages(name); });
            }).catch(function () {}));
          }
          return res;
        });
      });
    });
  });
}

var trimming = {};
function trimImages(name) {
  if (trimming[name]) return trimming[name];
  trimming[name] = caches.open(name).then(function (cache) {
    return cache.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return cache.match(k); })).then(function (rs) {
        var items = keys.map(function (k, i) {
          var h = rs[i] ? rs[i].headers : new Headers();
          return { key: k, bytes: +h.get("X-Zk-Bytes") || 0, time: +h.get("X-Zk-Time") || 0 };
        }).sort(function (a, b) { return a.time - b.time; });
        var total = items.reduce(function (s, x) { return s + x.bytes; }, 0), dels = [];
        while (items.length && (items.length > IMG_MAX_ENTRIES || total > IMG_MAX_BYTES)) {
          var old = items.shift(); total -= old.bytes; dels.push(cache.delete(old.key));
        }
        return Promise.all(dels);
      });
    });
  }).then(function () { delete trimming[name]; }, function () { delete trimming[name]; });
  return trimming[name];
}

// ------------------------------------------------------------ events
if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("install", function (event) {
    event.waitUntil(caches.open(SHELL_CACHE).then(function (c) {
      return c.addAll(SHELL_FILES.map(function (u) { return new Request(u, { cache: "reload" }); }));
    }).then(function () { return self.skipWaiting(); }));
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) {
        if (n.indexOf("zk-") !== 0 || n === SHELL_CACHE || n === PUBLIC_CACHE || n === META_CACHE) return false;
        if (isUserCache(n)) return !new RegExp("-v" + DATA_VERSION + "$").test(n);
        return true;                              // old shell versions, old public caches
      }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); }));
  });

  self.addEventListener("fetch", function (event) {
    var req = event.request, kind;
    try { kind = classify(req.method, req.url, api, req.mode, self.location.origin); } catch (e) { return; }
    if (!kind) return;                            // POSTs, login, invites, admin, app-error...: untouched
    if (kind === "shell") event.respondWith(handleShell(event));
    else if (kind === "media") event.respondWith(handleMedia(event));
    else event.respondWith(handleApi(event, kind));
  });

  self.addEventListener("message", function (event) {
    var d = event.data || {}, done;
    if (d.type === "zk-user") done = queueUser(d.uid);
    else if (d.type === "zk-clear") done = queueUser(null);
    else return;
    var port = event.ports && event.ports[0];
    event.waitUntil(done.then(function () { if (port) port.postMessage({ ok: true }); },
      function () { if (port) port.postMessage({ ok: false }); }));
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { VERSION: VERSION, DATA_VERSION: DATA_VERSION, DEFAULT_API: DEFAULT_API, SHELL_CACHE: SHELL_CACHE,
    SHELL_FILES: SHELL_FILES, apiCacheName: apiCacheName, imgCacheName: imgCacheName, mediaCacheKey: mediaCacheKey,
    apiCacheKey: apiCacheKey, classify: classify };
}
