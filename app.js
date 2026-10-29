/* זיכרון - single-page frontend. No build step, no dependencies.
   All user content is inserted with textContent (no HTML string injection). */
(function () {
  "use strict";

  // ------------------------------------------------------------ config
  var API = String(window.API_BASE || "").replace(/\/+$/, "");
  var isLocal = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  if (isLocal) {
    try {
      var q = new URLSearchParams(location.search).get("api");
      if (q) localStorage.setItem("apiBase", q);
      API = (localStorage.getItem("apiBase") || API).replace(/\/+$/, "");
    } catch (e) {}
  }
  var MAX_UPLOAD = 25 * 1024 * 1024;
  var app = document.getElementById("app");
  var nav = document.getElementById("nav");

  // ------------------------------------------------------------ token storage
  function getToken() { try { return localStorage.getItem("zk_token"); } catch (e) { return null; } }
  function setToken(t) { try { t ? localStorage.setItem("zk_token", t) : localStorage.removeItem("zk_token"); } catch (e) {} }
  var me = null;

  // ------------------------------------------------------------ offline cache (service worker)
  // The SW keeps per-user caches (zk-api-u<id>-v<N>, zk-img-u<id>-v<N>). It never sees the token: we only tell it the user id.
  var hasSW = false;
  try { hasSW = "serviceWorker" in navigator && !!navigator.serviceWorker && window.isSecureContext !== false; } catch (e) {}
  function swPost(msg) {
    if (!hasSW) return;
    try {
      var c = navigator.serviceWorker.controller;
      if (c) c.postMessage(msg);
      navigator.serviceWorker.ready.then(function (r) { if (r.active && r.active !== c) r.active.postMessage(msg); }).catch(function () {});
    } catch (e) {}
  }
  // Wipe every user's cached API data and images (logout, 401, token change). Also done from the page, in case no SW runs.
  function clearOfflineCache() {
    try { localStorage.removeItem("zk_uid"); } catch (e) {}
    swPost({ type: "zk-clear" });
    try {
      // No controlling SW (e.g. it is still installing): delete from the page. Otherwise the SW does it, in order.
      if (window.caches && !(hasSW && navigator.serviceWorker.controller)) caches.keys().then(function (ns) {
        ns.forEach(function (n) { if (/^zk-(api|img)-u\d+-v\d+$/.test(n)) caches.delete(n); });
      }).catch(function () {});
    } catch (e) {}
  }
  // Tell the SW who is logged in; it deletes every other user's caches.
  function setOfflineUser(u) {
    if (!u || !u.id) return;
    try { localStorage.setItem("zk_uid", String(u.id)); } catch (e) {}
    swPost({ type: "zk-user", uid: u.id });
  }
  function storedUid() { try { return localStorage.getItem("zk_uid"); } catch (e) { return null; } }
  function signOut() { setToken(null); me = null; clearOfflineCache(); }

  // ------------------------------------------------------------ online / offline state
  var offline = false, banner = null, updateReady = false;
  function isOffline() { return offline || navigator.onLine === false; }
  function setOffline(v) {
    offline = !!v;
    var on = isOffline();
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "offline-banner"; banner.setAttribute("role", "status"); banner.hidden = true;
      banner.textContent = "אין חיבור לאינטרנט · מוצג מהשמירה האחרונה";
      document.body.appendChild(banner);
    }
    banner.hidden = !on;
    document.body.classList.toggle("is-offline", on);
    document.querySelectorAll("form[data-needs-net]").forEach(function (f) {
      var b = f.querySelector("button[type=submit]"), note = f.querySelector(".offline-note");
      if (b && !f.getAttribute("data-busy")) b.disabled = on;
      if (note) note.hidden = !on;
    });
  }
  window.addEventListener("online", function () { setOffline(false); });
  window.addEventListener("offline", function () { setOffline(true); });

  // ------------------------------------------------------------ API
  function api(method, path, body) {
    var opts = { method: method, headers: {}, credentials: "omit", mode: "cors" };
    var t = getToken();
    if (t) opts.headers["Authorization"] = "Bearer " + t;
    if (body instanceof FormData) opts.body = body;
    else if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (r) {
      // X-Zk-Time is set only on copies the service worker stored, so its presence means "served from cache".
      if (method === "GET") setOffline(!!r.headers.get("X-Zk-Time"));
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && t) clearOfflineCache();     // expired or revoked token: drop the offline copy
        if (r.status === 401 && t && path.indexOf("/auth/") !== 0 && path.indexOf("/invites/") !== 0) {
          setToken(null); me = null; renderNav();
          go("#/login?next=" + encodeURIComponent(location.hash));
        }
        if (!r.ok) { var err = new Error(data.error || "משהו השתבש. נא לנסות שוב."); err.status = r.status; throw err; }
        return data;
      });
    }, function () {
      setOffline(true);
      var err = new Error("אין חיבור לשרת. נא לבדוק את האינטרנט ולנסות שוב."); err.offline = true; throw err;
    });
  }
  function mediaSrc(rel) { return rel ? API + rel : ""; }

  // ------------------------------------------------------------ DOM helpers
  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") el.textContent = v;
      else if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  function show() {
    app.textContent = "";
    for (var i = 0; i < arguments.length; i++) add(app, arguments[i]);
    window.scrollTo(0, 0);
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function msgBox() { return h("p", { class: "msg err", role: "alert", hidden: true }); }
  function showMsg(box, text, kind) { box.className = "msg " + (kind || "err"); box.textContent = text; box.hidden = false; }
  function loading() { show(h("p", { class: "hint center", text: "טוען..." })); }

  var SVGNS = "http://www.w3.org/2000/svg";
  function candle() {
    var s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 40 64"); s.setAttribute("class", "candle"); s.setAttribute("aria-hidden", "true");
    [["path", { class: "flame", d: "M20 4c5 8 7 12 7 16a7 7 0 0 1-14 0c0-4 2-8 7-16z" }],
     ["rect", { class: "wax", x: 12, y: 28, width: 16, height: 32, rx: 3 }],
     ["line", { class: "wick", x1: 20, y1: 22, x2: 20, y2: 28 }]].forEach(function (p) {
      var el = document.createElementNS(SVGNS, p[0]);
      for (var k in p[1]) el.setAttribute(k, p[1][k]);
      s.appendChild(el);
    });
    return s;
  }
  function years(m) {
    if (m.birth_year && m.death_year) return m.birth_year + " – " + m.death_year;
    return String(m.birth_year || m.death_year || "");
  }
  function avatar(m, big) {
    var cls = "avatar" + (big ? " big" : "");
    return m.cover ? h("img", { class: cls, src: mediaSrc(m.cover), alt: "" }) : h("span", { class: cls }, candle());
  }
  function field(label, attrs) {
    return h("label", null, label, h(attrs.tag || "input", Object.assign({}, attrs, { tag: null })));
  }
  function identField(value) {
    return field("אימייל או מספר טלפון", { name: "ident", required: true, autocomplete: "username", inputmode: "email", value: value || "" });
  }
  function nameField() { return field("השם שלך", { name: "name", required: true, maxlength: 80, autocomplete: "name" }); }
  function newPwField() {
    return field("בחירת סיסמה (לפחות 6 תווים)", { name: "password", type: "password", required: true, minlength: 6, autocomplete: "new-password" });
  }
  function pwField() { return field("סיסמה", { name: "password", type: "password", required: true, autocomplete: "current-password" }); }
  function fileField(label, name, required) {
    var prev = h("img", { class: "preview", alt: "", hidden: true });
    var inp = h("input", { type: "file", name: name, accept: "image/*", required: required, onchange: function () {
      var f = inp.files && inp.files[0];
      if (f && f.size > MAX_UPLOAD) { alert("הקובץ גדול מ-25MB"); inp.value = ""; prev.hidden = true; return; }
      if (f && f.type.indexOf("image/") === 0) { prev.src = URL.createObjectURL(f); prev.hidden = false; }
      else prev.hidden = true;
    } });
    return [h("label", null, label, inp), prev];
  }
  function formObj(form) {
    var o = {};
    new FormData(form).forEach(function (v, k) { if (typeof v === "string") o[k] = v; });
    return o;
  }
  function hasFile(form) {
    var found = false;
    form.querySelectorAll("input[type=file]").forEach(function (i) { if (i.files && i.files.length) found = true; });
    return found;
  }
  // Build a form whose submit calls `send(form)` (returns a promise) with a busy button and error box.
  function form(children, submitText, send, opts) {
    opts = opts || {};
    var box = msgBox();
    var btn = h("button", { class: "btn big" + (opts.ghost ? " ghost" : ""), type: "submit", text: submitText });
    var note = opts.needsNet ? h("p", { class: "msg offline-note", hidden: !isOffline(), text: "העלאה תתאפשר כשהחיבור יחזור" }) : null;
    var f = h("form", { novalidate: false, "data-needs-net": opts.needsNet ? "1" : null }, box, children, note, btn);
    if (opts.needsNet && isOffline()) btn.disabled = true;
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (opts.needsNet && isOffline()) { if (note) note.hidden = false; return; }
      btn.disabled = true; var old = btn.textContent; btn.textContent = opts.busy || "רגע...";
      f.setAttribute("data-busy", "1");
      Promise.resolve().then(function () { return send(f); }).catch(function (e) {
        f.removeAttribute("data-busy");
        showMsg(box, e.message); btn.disabled = opts.needsNet && isOffline(); btn.textContent = old;
      });
    });
    return f;
  }

  // ------------------------------------------------------------ nav
  function renderNav() {
    nav.textContent = "";
    if (me) {
      add(nav, h("a", { href: "#/", text: "הדפים שלי" }));
      add(nav, h("button", { class: "link", type: "button", text: "יציאה", onclick: function () {
        clearOfflineCache();
        api("POST", "/auth/logout").catch(function () {}).then(function () { signOut(); renderNav(); go("#/"); });
      } }));
    }
  }
  // A new token (login, register, invite join): wipe any earlier offline copy, then bind the caches to this user.
  function signedIn(data) {
    if (data.token !== getToken()) clearOfflineCache();
    setToken(data.token); me = data.user; setOfflineUser(me); renderNav();
  }
  function needLogin() {
    if (me) return false;
    go("#/login?next=" + encodeURIComponent(location.hash));
    return true;
  }
  function safeNext(n) { return n && /^#\/[^/]/.test(n) ? n : "#/"; }

  // ------------------------------------------------------------ views
  function viewHome() {
    if (!me) {
      return show(h("section", { class: "hero" }, candle(), h("h1", { text: "זיכרון" }),
        h("p", { class: "lead", text: "מקום שקט ופרטי לשמור את הזיכרונות של מי שאהבנו: תמונות, סיפורים ורגעים, יחד עם המשפחה והחברים." }),
        h("a", { class: "btn big", href: "#/register", text: "פתיחת חשבון" }),
        h("a", { class: "btn big ghost", href: "#/login", text: "כבר יש לי חשבון" })));
    }
    loading();
    api("GET", "/memorials").then(function (d) {
      var list = d.memorials.map(function (m) {
        return h("li", null, h("a", { class: "mcard", href: "#/m/" + m.slug }, avatar(m),
          h("span", { class: "mname", text: m.name }), h("span", { class: "years", text: years(m) })));
      });
      show(h("section", null, h("h1", { text: "שלום " + me.name }),
        h("a", { class: "btn big", href: "#/new", text: "+ יצירת דף זיכרון חדש" }),
        list.length ? h("ul", { class: "mlist" }, list)
          : h("p", { class: "hint", text: "עדיין אין דפים. אפשר ליצור דף חדש, או להצטרף לדף בעזרת קישור הזמנה." })));
    }).catch(errorView);
  }

  function viewLogin(params) {
    if (me) return go("#/");
    var next = safeNext(params.get("next"));
    show(h("section", { class: "card narrow" }, h("h1", { text: "כניסה" }),
      form([identField(), pwField()], "כניסה", function (f) {
        return api("POST", "/auth/login", formObj(f)).then(function (d) { signedIn(d); go(next); });
      }),
      h("p", { class: "hint" }, "אין לך חשבון? ", h("a", { href: "#/register", text: "פתיחת חשבון" }))));
  }

  function viewRegister() {
    if (me) return go("#/");
    show(h("section", { class: "card narrow" }, h("h1", { text: "פתיחת חשבון" }),
      form([nameField(), identField(), newPwField()], "פתיחת חשבון", function (f) {
        return api("POST", "/auth/register", formObj(f)).then(function (d) { signedIn(d); go("#/"); });
      }),
      h("p", { class: "hint" }, "כבר יש לך חשבון? ", h("a", { href: "#/login", text: "כניסה" }))));
  }

  function memorialFields(m) {
    m = m || {};
    return [
      field("שם מלא", { name: "name", required: true, maxlength: 100, value: m.name || "" }),
      h("div", { class: "row" },
        field("שנת לידה", { name: "birth_year", inputmode: "numeric", maxlength: 4, value: m.birth_year || "" }),
        field("שנת פטירה", { name: "death_year", inputmode: "numeric", maxlength: 4, value: m.death_year || "" })),
      field("כמה מילים עליו/עליה", { tag: "textarea", name: "bio", rows: 5, maxlength: 4000, text: m.bio || "" }),
      fileField(m.name ? "החלפת התמונה הראשית" : "תמונה ראשית", "cover", false)
    ];
  }

  function viewNew() {
    if (needLogin()) return;
    show(h("section", { class: "card" }, h("h1", { text: "דף זיכרון חדש" }),
      h("p", { class: "hint", text: "הדף פרטי. רק מי שתזמינו יוכל לראות אותו." }),
      form(memorialFields(), "יצירת הדף", function (f) {
        return api("POST", "/memorials", new FormData(f)).then(function (d) {
          if (d.cover_error) alert(d.cover_error);
          go("#/m/" + d.memorial.slug);
        });
      }, { busy: "שומר...", needsNet: true })));
  }

  function viewMemorial(slug, params) {
    if (needLogin()) return;
    var flt = params.get("f") || "all";
    loading();
    api("GET", "/memorials/" + encodeURIComponent(slug) + "?filter=" + encodeURIComponent(flt)).then(function (d) {
      var m = d.memorial, groups = [], cur, retried = false;
      // Signed image URLs expire after ~10 minutes; reload the view once if one fails.
      function onImgErr() { if (!retried && !isOffline()) { retried = true; setTimeout(function () { viewMemorial(slug, params); }, 300); } }
      d.items.forEach(function (it) {
        if (!cur || cur.year !== it.year) { cur = { year: it.year, items: [] }; groups.push(cur); }
        var meta = h("p", { class: "meta", text: it.author + (it.date ? " · " + it.date : "") });
        if (it.type === "photo") {
          cur.items.push(h("figure", { class: "item photo" },
            h("a", { href: mediaSrc(it.url), target: "_blank", rel: "noopener" },
              h("img", { loading: "lazy", src: mediaSrc(it.thumb), alt: it.caption || "", onerror: onImgErr })),
            h("figcaption", null, it.caption || "", meta)));
        } else {
          cur.items.push(h("article", { class: "item story" }, h("h3", { text: it.title }), meta,
            h("div", { class: "text", text: it.body })));
        }
      });
      var tabs = [["all", "הכול"], ["photos", "תמונות"], ["stories", "סיפורים"]].map(function (t) {
        return h("a", { class: "tab" + (d.filter === t[0] ? " on" : ""), href: "#/m/" + slug + (t[0] === "all" ? "" : "?f=" + t[0]), text: t[1] });
      });
      show(
        h("section", { class: "mhead" }, avatar(m, true), h("div", null, h("h1", { text: m.name }), h("p", { class: "years", text: years(m) }))),
        m.bio ? h("section", { class: "bio", text: m.bio }) : null,
        h("div", { class: "actions" },
          h("a", { class: "btn big", href: "#/m/" + slug + "/photo", text: "+ הוספת תמונה" }),
          h("a", { class: "btn big", href: "#/m/" + slug + "/story", text: "+ כתיבת סיפור" }),
          m.role === "admin" ? h("a", { class: "btn ghost", href: "#/m/" + slug + "/edit", text: "עריכה והזמנת משפחה" }) : null),
        h("nav", { class: "tabs" }, tabs),
        h("div", { class: "timeline" }, groups.length ? groups.map(function (g) {
          return h("section", { class: "year" }, h("h2", { class: "ylabel", text: g.year ? String(g.year) : "ללא שנה" }),
            h("div", { class: "yitems" }, g.items));
        }) : h("p", { class: "hint", text: "עדיין אין כאן זיכרונות. אפשר להתחיל בתמונה או בסיפור." })));
    }).catch(errorView);
  }

  function viewPhoto(slug) {
    if (needLogin()) return;
    show(h("section", { class: "card" }, h("h1", { text: "הוספת תמונה" }),
      form([fileField("תמונה (עד 25MB)", "photo", true),
        field("כיתוב", { name: "caption", maxlength: 500 }),
        field("שנה או תאריך (לא חובה)", { name: "date", maxlength: 40, placeholder: "למשל 1975" })],
        "העלאה", function (f) {
          if (!hasFile(f)) throw new Error("נא לבחור תמונה.");
          return api("POST", "/memorials/" + encodeURIComponent(slug) + "/photos", new FormData(f)).then(function () { go("#/m/" + slug); });
        }, { busy: "מעלה...", needsNet: true }),
      h("a", { href: "#/m/" + slug, text: "חזרה" })));
  }

  function viewStory(slug) {
    if (needLogin()) return;
    show(h("section", { class: "card" }, h("h1", { text: "כתיבת סיפור או זיכרון" }),
      form([field("כותרת", { name: "title", required: true, maxlength: 200 }),
        field("הסיפור", { tag: "textarea", name: "body", rows: 10, required: true, maxlength: 20000 }),
        field("שנה או תאריך (לא חובה)", { name: "date", maxlength: 40, placeholder: "למשל קיץ 1982" })],
        "שמירה", function (f) {
          return api("POST", "/memorials/" + encodeURIComponent(slug) + "/stories", formObj(f)).then(function () { go("#/m/" + slug); });
        }, { needsNet: true }),
      h("a", { href: "#/m/" + slug, text: "חזרה" })));
  }

  function inviteLink(tok) { return location.origin + location.pathname + "#/join/" + tok; }

  function viewEdit(slug) {
    if (needLogin()) return;
    loading();
    var s = encodeURIComponent(slug);
    Promise.all([api("GET", "/memorials/" + s), api("GET", "/memorials/" + s + "/admin")]).then(function (r) {
      var m = r[0].memorial, adm = r[1];
      var linkInput = h("input", { class: "copy", readonly: true, value: inviteLink(adm.invite_token) });
      var copyBtn = h("button", { class: "btn", type: "button", text: "העתקת הקישור", onclick: function () {
        linkInput.select();
        var done = function () { copyBtn.textContent = "הקישור הועתק ✓"; };
        if (navigator.clipboard) navigator.clipboard.writeText(linkInput.value).then(done, function () { document.execCommand("copy"); done(); });
        else { document.execCommand("copy"); done(); }
      } });
      var shareBtn = navigator.share ? h("button", { class: "btn ghost", type: "button", text: "שיתוף", onclick: function () {
        navigator.share({ title: "דף הזיכרון של " + m.name, text: "הוזמנת להצטרף לדף הזיכרון של " + m.name, url: linkInput.value }).catch(function () {});
      } }) : null;
      var resetBtn = h("button", { class: "btn ghost small", type: "button", text: "ביטול הקישור ויצירת קישור חדש", onclick: function () {
        if (!confirm("הקישור הישן יפסיק לעבוד. להמשיך?")) return;
        api("POST", "/memorials/" + s + "/invite/reset").then(function (d) {
          linkInput.value = inviteLink(d.invite_token); copyBtn.textContent = "העתקת הקישור";
        }).catch(function (e) { alert(e.message); });
      } });
      show(
        h("section", { class: "card" }, h("h1", { text: "עריכת הדף" }),
          form(memorialFields(m), "שמירה", function (f) {
            return api("POST", "/memorials/" + s + "/edit", new FormData(f)).then(function () { go("#/m/" + slug); });
          }, { busy: "שומר...", needsNet: true })),
        h("section", { class: "card" }, h("h2", { text: "הזמנת משפחה וחברים" }),
          h("p", { text: "שלחו את הקישור הזה (למשל בוואטסאפ). מי שיפתח אותו יוכל להצטרף בצעד אחד." }),
          linkInput, h("p", null, copyBtn, " ", shareBtn), resetBtn,
          h("h3", { text: "חברים בדף" }),
          h("ul", { class: "members" }, adm.members.map(function (x) {
            return h("li", { text: x.name + (x.role === "admin" ? " (מנהל/ת)" : "") });
          }))),
        h("a", { href: "#/m/" + slug, text: "חזרה לדף" }));
    }).catch(errorView);
  }

  function viewJoin(token) {
    loading();
    var t = encodeURIComponent(token);
    api("GET", "/invites/" + t).then(function (inv) {
      if (inv.already_member) return go("#/m/" + inv.slug);
      var intro = h("section", { class: "hero small" }, candle(), h("h1", { text: inv.name }),
        h("p", { class: "years", text: years(inv) }), h("p", { class: "lead", text: "הוזמנת להצטרף לדף הזיכרון." }));
      function joined(d) { if (d.token) signedIn(d); go("#/m/" + d.slug); }
      if (me) {
        return show(intro, h("section", { class: "card narrow" },
          form([], "הצטרפות לדף", function () { return api("POST", "/invites/" + t + "/join").then(joined); })));
      }
      show(intro,
        h("section", { class: "card narrow" }, h("h2", { text: "הצטרפות בצעד אחד" }),
          form([nameField(), identField(), newPwField()], "הצטרפות", function (f) {
            var o = formObj(f); o.mode = "new";
            return api("POST", "/invites/" + t + "/join", o).then(joined);
          })),
        h("section", { class: "card narrow" }, h("h2", { text: "כבר יש לי חשבון" }),
          form([identField(), pwField()], "כניסה והצטרפות", function (f) {
            var o = formObj(f); o.mode = "login";
            return api("POST", "/invites/" + t + "/join", o).then(joined);
          }, { ghost: true })));
    }).catch(errorView);
  }

  // Offline and nothing cached for this screen (e.g. the very first launch without internet).
  function offlineView() {
    show(h("section", { class: "card center" }, candle(),
      h("h1", { text: "אין כרגע חיבור לאינטרנט" }),
      h("p", { text: "המסך הזה עוד לא נשמר במכשיר. כשהחיבור יחזור, הכול יופיע כאן." }),
      h("button", { class: "btn big", type: "button", text: "נסו שוב", onclick: function () { start(); } })));
  }

  function errorView(e) {
    if (e && e.status === 401) return;
    if (e && e.offline) return offlineView();
    show(h("section", { class: "card center" }, candle(),
      h("h1", { text: e && e.status === 404 ? "הדף לא נמצא" : "משהו השתבש" }),
      h("p", { text: (e && e.message) || "נא לנסות שוב." }),
      h("a", { class: "btn", href: "#/", text: "לדף הבית" })));
  }

  // ------------------------------------------------------------ router
  function route() {
    if (updateReady) { location.reload(); return; }   // a new version was installed: pick it up on the next navigation
    var hash = location.hash.replace(/^#/, "") || "/";
    var qi = hash.indexOf("?");
    var path = qi >= 0 ? hash.slice(0, qi) : hash;
    var params = new URLSearchParams(qi >= 0 ? hash.slice(qi + 1) : "");
    var m;
    if (path === "/" || path === "") return viewHome();
    if (path === "/login") return viewLogin(params);
    if (path === "/register") return viewRegister();
    if (path === "/new") return viewNew();
    if ((m = path.match(/^\/join\/([\w-]+)$/))) return viewJoin(m[1]);
    if ((m = path.match(/^\/m\/([\w-]+)$/))) return viewMemorial(m[1], params);
    if ((m = path.match(/^\/m\/([\w-]+)\/photo$/))) return viewPhoto(m[1]);
    if ((m = path.match(/^\/m\/([\w-]+)\/story$/))) return viewStory(m[1]);
    if ((m = path.match(/^\/m\/([\w-]+)\/edit$/))) return viewEdit(m[1]);
    errorView({ status: 404, message: "ייתכן שהקישור שגוי." });
  }

  function start() {
    // 404.html fallback: a path like /join/<token> (no hash) becomes #/join/<token>
    if (!location.hash && location.pathname.length > 1 && !/\/(index|404)\.html$/.test(location.pathname)) {
      var p = location.pathname.replace(/^.*?(\/(join|m)\/.*)$/, "$1");
      if (p !== location.pathname || /^\/(join|m)\//.test(p)) { location.replace(location.origin + "/#" + p); return; }
    }
    if (!started) { started = true; window.addEventListener("hashchange", route); registerSW(); }
    setOffline(false);
    if (!getToken()) {
      if (storedUid()) clearOfflineCache();
      renderNav(); return route();
    }
    api("GET", "/auth/me").then(function (d) {
      me = d.user;
      if (storedUid() !== String(me.id)) clearOfflineCache();   // token now belongs to someone else
      setOfflineUser(me);
      renderNav(); route();
    }, function (e) {
      if (e && e.offline) { me = null; renderNav(); return offlineView(); }  // keep the token: we are only offline
      signOut(); renderNav(); route();
    });
  }

  function registerSW() {
    if (!hasSW) return;
    try {
      var url = "/sw.js";
      if (isLocal && API !== String(window.API_BASE || "").replace(/\/+$/, "")) url += "?api=" + encodeURIComponent(API);
      var hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", function () { if (hadController) updateReady = true; hadController = true; });
      navigator.serviceWorker.register(url, { scope: "/" }).catch(function () {});
    } catch (e) {}
  }
  var started = false;
  start();
})();
