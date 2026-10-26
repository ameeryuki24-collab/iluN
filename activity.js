'use strict';
/**
 * Nw Activity — متجر البوت كتطبيق (Discord Activity) داخل ديسكورد.
 * - سيرفر ويب صغير (بدون مكتبات خارجية) يشتغل مع البوت بنفس العملية.
 * - يخدم صفحة الويب + واجهة API للمتجر/المخزون/التوب/البروفايل.
 * - يحتاج: CLIENT_ID + CLIENT_SECRET (من Developer Portal) + رابط HTTPS عام للبورت.
 *
 * ⚠️ ما أقدر أجربه على ديسكورد الحقيقي من عندي — الخطوات بملف التعليمات.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSIONS = new Map(); // token -> { uid, name, avatar, exp }
const IMG_CACHE = new Map();
const SESSION_TTL = 6 * 3600 * 1000;
const RATE = new Map(); // token -> [timestamps]

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function getSession(req, url) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('t') || '');
  const s = SESSIONS.get(tok);
  if (!s || s.exp < Date.now()) return null;
  // حد أقصى للطلبات: 60 طلب كل 10 ثواني لكل جلسة
  const now = Date.now(); const arr = (RATE.get(tok) || []).filter(t => now - t < 10000); arr.push(now); RATE.set(tok, arr);
  if (arr.length > 60) return 'rate';
  return { ...s, token: tok };
}

// ---------- مكتبة الـ SDK (تُقدَّم من السيرفر نفسه عشان ما نحتاج CDN داخل الـ Activity) ----------
let sdkCache = null;
async function getSdkSource() {
  if (sdkCache) return sdkCache;
  const local = path.join(__dirname, 'embedded-app-sdk.js');
  const cacheFile = path.join(__dirname, '.activity-sdk-cache.js');
  for (const f of [local, cacheFile]) { try { if (fs.existsSync(f)) { sdkCache = fs.readFileSync(f, 'utf8'); return sdkCache; } } catch (e) { /* next */ } }
  let url = 'https://esm.sh/@discord/embedded-app-sdk?bundle&target=es2020';
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('SDK HTTP ' + r.status);
    const body = await r.text();
    const m = body.length < 2500 && body.match(/from\s*["'](\/[^"']+)["']/);
    if (m) { url = new URL(m[1], 'https://esm.sh').toString(); continue; }
    sdkCache = body;
    try { fs.writeFileSync(cacheFile, body); } catch (e) { /* ignore */ }
    return sdkCache;
  }
  throw new Error('تعذر تحميل الـ SDK');
}

function startActivityServer(ctx) {
  if (process.env.ACTIVITY_DISABLED === '1') return null;
  const port = Number(process.env.PORT || process.env.SERVER_PORT || process.env.ACTIVITY_PORT || 3000);
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  if (!clientSecret) console.warn('⚠️ CLIENT_SECRET غير موجود بملف .env — الـ Activity ما راح تقدر تسجّل الدخول.');

  const itemDTO = (it, p) => {
    const st = ctx.itemState(p, it), rar = ctx.rarityOf(it.price);
    return { id: it.id, name: it.name, emoji: it.emoji || '', price: it.price, type: it.type, desc: it.desc || '', rarity: { key: rar.key, ar: rar.ar, color: rar.color }, owned: !!st.owned, equipped: !!st.equipped, count: st.count || 0 };
  };
  const bundleDTO = (b, p) => {
    const info = ctx.bundleInfo(b, p);
    return { id: b.id, ar: b.ar, en: b.en, off: b.off, items: info.items.map(i => itemDTO(i, p)), full: info.full, cost: info.cost, allOwned: !info.unowned.length, partial: info.unowned.length !== info.items.length };
  };
  const userCache = new Map();
  async function userInfo(uid) {
    if (userCache.has(uid)) return userCache.get(uid);
    let u = ctx.client.users.cache.get(uid);
    if (!u) u = await ctx.client.users.fetch(uid).catch(() => null);
    const info = { id: uid, name: u ? (u.globalName || u.username) : 'Unknown', avatar: u ? u.displayAvatarURL({ extension: 'png', size: 64 }) : null };
    userCache.set(uid, info); if (userCache.size > 500) userCache.delete(userCache.keys().next().value);
    return info;
  }
  const REASONS = { owned: 'تملك هذا العنصر مسبقاً.', poor: 'نقاطك غير كافية.', notforsale: 'هذا العنصر غير معروض للبيع.', missing: 'عنصر غير معروف.' };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(HTML.replace(/__CLIENT_ID__/g, String(clientId)));
      }
      if (req.method === 'GET' && p === '/sdk.js') {
        try { const src = await getSdkSource(); res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); return res.end(src); }
        catch (e) { console.error('Activity SDK:', e.message); res.writeHead(502); return res.end('sdk unavailable'); }
      }
      if (req.method === 'GET' && p === '/health') { res.writeHead(200); return res.end('ok'); }

      // ---- تسجيل الدخول ----
      if (req.method === 'POST' && p === '/api/token') {
        if (!clientSecret) return json(res, 500, { error: 'CLIENT_SECRET غير مضبوط على السيرفر.' });
        const { code } = await readBody(req);
        if (!code || typeof code !== 'string') return json(res, 400, { error: 'code مطلوب' });
        const r = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code })
        });
        const tok = await r.json().catch(() => ({}));
        if (!r.ok || !tok.access_token) return json(res, 401, { error: 'فشل تسجيل الدخول مع ديسكورد.' });
        const ur = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
        const u = await ur.json().catch(() => ({}));
        if (!ur.ok || !u.id) return json(res, 401, { error: 'تعذر قراءة المستخدم.' });
        const session = crypto.randomBytes(24).toString('hex');
        SESSIONS.set(session, { uid: u.id, name: u.global_name || u.username, exp: Date.now() + SESSION_TTL });
        if (SESSIONS.size > 2000) for (const [k, v] of SESSIONS) if (v.exp < Date.now()) SESSIONS.delete(k);
        return json(res, 200, { access_token: tok.access_token, session });
      }

      // ---- كل ما تحت يحتاج جلسة ----
      if (p.startsWith('/api/')) {
        const s = getSession(req, url);
        if (!s) return json(res, 401, { error: 'الجلسة منتهية، أعد فتح التطبيق.' });
        if (s === 'rate') return json(res, 429, { error: 'طلبات كثيرة، انتظر شوي.' });
        const prof = ctx.getGameProfile(s.uid);

        if (req.method === 'GET' && p === '/api/me') {
          return json(res, 200, { id: s.uid, name: s.name, points: prof.points, level: prof.level });
        }
        if (req.method === 'GET' && p === '/api/shop') {
          return json(res, 200, {
            points: prof.points,
            categories: ctx.SHOP_CATEGORIES.map(c => ({ id: c.id, label: c.label, emoji: c.emoji, desc: c.desc, count: ctx.shopItemsForCategory(c.id).length })),
            bundles: ctx.SHOP_BUNDLES.length
          });
        }
        if (req.method === 'GET' && p === '/api/items') {
          const cat = url.searchParams.get('cat') || '';
          if (!ctx.SHOP_CATEGORIES.some(c => c.id === cat)) return json(res, 400, { error: 'قسم غير معروف' });
          return json(res, 200, { points: prof.points, items: ctx.shopItemsForCategory(cat).map(i => itemDTO(i, prof)) });
        }
        if (req.method === 'GET' && p === '/api/bundles') {
          return json(res, 200, { points: prof.points, bundles: ctx.SHOP_BUNDLES.map(b => bundleDTO(b, prof)) });
        }
        if (req.method === 'GET' && p === '/api/inventory') {
          const out = [];
          for (const [type, key] of [['banner', 'banners'], ['badge', 'badges'], ['decoration', 'decorations'], ['frame', 'frames'], ['title', 'titles']]) {
            for (const id of prof.owned[key] || []) { const it = ctx.getShopItem(id); if (it) out.push(itemDTO(it, prof)); }
          }
          for (const [id, q] of Object.entries(prof.inventory || {})) { if (q > 0) { const it = ctx.getShopItem(id); if (it) out.push(itemDTO(it, prof)); } }
          return json(res, 200, { points: prof.points, items: out });
        }
        if (req.method === 'GET' && p === '/api/top') {
          const type = ['points', 'wins', 'xp'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'points';
          const board = ctx.getLeaderboard(type, 'global', null);
          const rows = await Promise.all(board.map(async (e, i) => ({ rank: i + 1, value: type === 'xp' ? e.profile.level : e.value, user: await userInfo(e.uid), me: e.uid === s.uid })));
          return json(res, 200, { type, rows });
        }
        if (req.method === 'GET' && p === '/api/profile') {
          const eq = {};
          for (const [k, v] of Object.entries(prof.equipped || {})) { const it = v ? ctx.getShopItem(v) : null; eq[k] = it ? it.name : null; }
          return json(res, 200, {
            name: s.name, points: prof.points, level: prof.level, xp: prof.xp, wins: prof.wins, losses: prof.losses, plays: prof.roulettePlays,
            matchWins: prof.matchWins, kicks: prof.kicksGiven, saves: prof.savesGiven, rank: ctx.getRankOf(s.uid, 'points', 'global', null), equipped: eq
          });
        }
        if (req.method === 'POST' && p === '/api/buy') {
          const { itemId } = await readBody(req);
          const item = ctx.getShopItem(String(itemId || ''));
          const res0 = item ? ctx.purchaseItem(s.uid, item) : { ok: false, reason: 'missing' };
          return json(res, 200, { ok: !!res0.ok, message: res0.ok ? `تم شراء ${item.name}!` : REASONS[res0.reason] || 'تعذر الشراء.', points: ctx.getGameProfile(s.uid).points });
        }
        if (req.method === 'POST' && p === '/api/buy-bundle') {
          const { id } = await readBody(req);
          const b = ctx.SHOP_BUNDLES.find(x => x.id === id);
          const r0 = b ? ctx.purchaseBundle(s.uid, b) : { ok: false, reason: 'missing' };
          return json(res, 200, { ok: !!r0.ok, message: r0.ok ? `تم شراء الحزمة (${r0.count} عناصر بـ ${r0.cost} نقطة)!` : (r0.reason === 'poor' ? `نقاطك غير كافية (تحتاج ${r0.cost}).` : REASONS[r0.reason] || 'تعذر الشراء.'), points: ctx.getGameProfile(s.uid).points });
        }
        if (req.method === 'POST' && p === '/api/equip') {
          const { itemId } = await readBody(req);
          const item = ctx.getShopItem(String(itemId || ''));
          const key = item ? ctx.ownedListKey(item.type) : null;
          if (!item || item.type === 'consumable' || !prof.owned[key] || !prof.owned[key].includes(item.id)) return json(res, 200, { ok: false, message: 'ما تملك هذا العنصر.' });
          prof.equipped[item.type] = prof.equipped[item.type] === item.id ? null : item.id; ctx.saveDatabase();
          return json(res, 200, { ok: true, equipped: prof.equipped[item.type] === item.id, message: prof.equipped[item.type] === item.id ? `تم تجهيز ${item.name}.` : `تم إلغاء تجهيز ${item.name}.` });
        }
        if (req.method === 'GET' && p.startsWith('/api/img/item/')) {
          const item = ctx.getShopItem(decodeURIComponent(p.slice('/api/img/item/'.length)));
          if (!item) { res.writeHead(404); return res.end(); }
          const key = item.id + '|' + (item.imageUrl || '') + '|' + (item.color || '') + '|' + (item.kind || '') + '|' + (item.text || '');
          let buf = IMG_CACHE.get(key);
          if (!buf) { buf = await ctx.renderItemPreviewPng(item); IMG_CACHE.set(key, buf); if (IMG_CACHE.size > 300) IMG_CACHE.delete(IMG_CACHE.keys().next().value); }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
          return res.end(buf);
        }
        return json(res, 404, { error: 'غير موجود' });
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      console.error('Activity server error:', e);
      try { json(res, 500, { error: 'خطأ داخلي' }); } catch (e2) { /* ignore */ }
    }
  });
  server.on('error', (e) => console.error('Activity server failed to start:', e.message));
  server.listen(port, '0.0.0.0', () => console.log(`🌐 Activity server يشتغل على البورت ${port}`));
  return server;
}

const HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Nw Shop</title>
<style>
:root{--bg:#071223;--card:#0d1e3a;--card2:#091428;--line:rgba(110,160,255,.28);--txt:#fff;--mut:#8fa3c7;--acc:#ffb347;--blue:#4aa3ff}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--txt);font-family:"Segoe UI",Tahoma,"Noto Sans Arabic",system-ui,sans-serif;min-height:100%}
body{background:radial-gradient(900px 400px at 15% -10%,rgba(255,150,60,.16),transparent),radial-gradient(800px 500px at 100% 100%,rgba(70,120,255,.2),transparent),var(--bg);padding-bottom:40px}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 6px}
h1{margin:0;font-size:22px;letter-spacing:1px}
.pill{display:flex;align-items:center;gap:8px;background:rgba(12,28,56,.92);border:2px solid rgba(76,160,255,.7);border-radius:999px;padding:6px 12px;font-weight:700;font-size:18px;direction:ltr}
.pill svg{width:26px;height:26px}
nav{display:flex;gap:8px;padding:8px 16px;overflow-x:auto}
nav button,.chip{border:1px solid var(--line);background:rgba(13,30,58,.8);color:var(--txt);border-radius:999px;padding:8px 14px;font-size:14px;white-space:nowrap;cursor:pointer;font-family:inherit}
nav button.on,.chip.on{background:var(--blue);color:#06101f;border-color:var(--blue);font-weight:700}
.chips{display:flex;gap:8px;padding:6px 16px;overflow-x:auto}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:10px 16px}
@media(min-width:700px){.grid{grid-template-columns:repeat(3,1fr)}}
.card{background:linear-gradient(180deg,var(--card),var(--card2));border:2px solid var(--line);border-radius:18px;overflow:hidden;position:relative;display:flex;flex-direction:column}
.card img{width:100%;display:block;background:#0a1630}
.card .b{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;flex:1}
.rar{font-size:11px;font-weight:700;letter-spacing:.5px;direction:ltr;text-align:right}
.nm{font-size:15px;font-weight:700;line-height:1.3}
.ds{font-size:12px;color:var(--mut);line-height:1.4;flex:1}
.tag{position:absolute;top:8px;left:8px;background:rgba(8,16,32,.88);border:2px solid;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:700;direction:ltr}
.btn{border:0;border-radius:999px;padding:10px;font-size:15px;font-weight:700;cursor:pointer;color:#fff;background:#0b1830;border:1.5px solid rgba(120,160,220,.4);display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;direction:ltr}
.btn.buy{background:linear-gradient(180deg,#2c6bff,#1a45b8);border-color:#5b8bff}
.btn.eq{background:#1a2b4d}.btn.on{background:#1f7a46;border-color:#2ecc71}
.btn:disabled{opacity:.5}
.btn svg{width:20px;height:20px}
.wide{grid-column:1/-1}
.bundle{padding:12px}.bundle .row{display:flex;gap:6px;margin:8px 0}.bundle .row img{width:20%;border-radius:10px}
.off{position:absolute;top:10px;left:10px;color:#ffc83d;border:2px solid #ffc83d;border-radius:999px;padding:2px 10px;font-weight:800;font-size:13px;background:rgba(255,200,60,.12);direction:ltr}
.old{text-decoration:line-through;color:var(--mut);font-size:13px}
.list{padding:10px 16px;display:flex;flex-direction:column;gap:8px}
.rowx{display:flex;align-items:center;gap:12px;background:rgba(13,30,58,.85);border:1.5px solid var(--line);border-radius:14px;padding:10px 12px}
.rowx.me{border-color:var(--acc)}.rowx img{width:38px;height:38px;border-radius:50%}.rowx .n{flex:1;font-weight:700}.rowx .v{display:flex;gap:6px;align-items:center;direction:ltr;font-weight:800}
.rk{width:28px;text-align:center;font-weight:800;color:var(--acc)}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:10px 16px}
.stat{background:rgba(13,30,58,.85);border:1.5px solid var(--line);border-radius:14px;padding:12px;text-align:center}.stat b{display:block;font-size:22px}.stat span{font-size:12px;color:var(--mut)}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#101f3d;border:2px solid var(--blue);border-radius:14px;padding:10px 16px;font-size:14px;display:none;z-index:9;max-width:90%;text-align:center}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;z-index:8}
#modal .box{background:#0d1e3a;border:2px solid var(--line);border-radius:18px;padding:18px;width:min(88%,340px);text-align:center}
#modal .acts{display:flex;gap:10px;margin-top:14px}#modal .acts .btn{flex:1}
.empty,.msg{padding:30px 16px;text-align:center;color:var(--mut)}
</style>
</head>
<body>
<header><h1>NW SHOP</h1><div class="pill"><span id="pts">0</span><svg viewBox="0 0 40 40"><defs><radialGradient id="cg" cx="35%" cy="30%"><stop offset="0" stop-color="#a8d8ff"/><stop offset=".55" stop-color="#3b7cff"/><stop offset="1" stop-color="#16277f"/></radialGradient></defs><circle cx="20" cy="20" r="17" fill="url(#cg)" stroke="#ffb347" stroke-width="3.5"/><path d="M22 7 L11 22 H19 L17 33 L30 17 H22 Z" fill="#ffe08a"/></svg></div></header>
<nav id="tabs"></nav>
<div id="sub"></div>
<main id="view"><div class="msg">جاري التحميل...</div></main>
<div id="toast"></div>
<div id="modal"><div class="box"><div id="mtxt"></div><div class="acts"><button class="btn buy" id="myes">تأكيد</button><button class="btn" id="mno">إلغاء</button></div></div></div>
<script type="module">
var CLIENT_ID = "__CLIENT_ID__";
var inDiscord = new URLSearchParams(location.search).has("frame_id");
var BASE = inDiscord ? "/.proxy" : "";
var session = null, points = 0, tab = "shop", cat = "banner", cats = [];
var $ = function (id) { return document.getElementById(id); };
var COIN = '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" fill="#3b7cff" stroke="#ffb347" stroke-width="3.5"/><path d="M22 7 L11 22 H19 L17 33 L30 17 H22 Z" fill="#ffe08a"/></svg>';
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function toast(t) { var e = $("toast"); e.textContent = t; e.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(function () { e.style.display = "none"; }, 2600); }
function setPts(n) { points = n; $("pts").textContent = Number(n).toLocaleString("en-US"); }
function confirmBox(text) { return new Promise(function (res) { $("mtxt").innerHTML = text; $("modal").style.display = "flex"; $("myes").onclick = function () { $("modal").style.display = "none"; res(true); }; $("mno").onclick = function () { $("modal").style.display = "none"; res(false); }; }); }
async function api(path, body) {
  var opt = { headers: { Authorization: "Bearer " + session } };
  if (body !== undefined) { opt.method = "POST"; opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  var r = await fetch(BASE + path, opt);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.error || "خطأ");
  return j;
}
function img(it) { return BASE + "/api/img/item/" + encodeURIComponent(it.id) + "?t=" + session; }
function tagFor(it) { if (it.equipped) return ["EQUIPPED", "#2ecc71"]; if (it.owned) return ["OWNED", "#8a93a6"]; if (it.count) return ["x" + it.count, "#4aa3ff"]; return null; }
function card(it, mode) {
  var t = tagFor(it);
  var btn;
  if (it.owned && it.type !== "consumable") btn = '<button class="btn ' + (it.equipped ? "on" : "eq") + '" data-eq="' + esc(it.id) + '">' + (it.equipped ? "مجهّز ✓" : "تجهيز") + "</button>";
  else if (mode === "inv") btn = '<div class="ds">استخدام مرة وحدة بالروليت</div>';
  else btn = '<button class="btn buy" data-buy="' + esc(it.id) + '" data-name="' + esc(it.name) + '" data-price="' + it.price + '">' + Number(it.price).toLocaleString("en-US") + COIN + "</button>";
  return '<div class="card" style="border-color:' + it.rarity.color + '"><img loading="lazy" src="' + img(it) + '">' + (t ? '<div class="tag" style="color:' + t[1] + ";border-color:" + t[1] + '">' + t[0] + "</div>" : "") +
    '<div class="b"><div class="rar" style="color:' + it.rarity.color + '">' + it.rarity.key + " • " + it.rarity.ar + '</div><div class="nm">' + esc(it.emoji) + " " + esc(it.name) + '</div><div class="ds">' + esc(it.desc) + "</div>" + btn + "</div></div>";
}
function bindActions(root, reload) {
  root.querySelectorAll("[data-buy]").forEach(function (b) { b.onclick = async function () {
    var ok = await confirmBox("شراء <b>" + b.dataset.name + "</b> مقابل <b>" + Number(b.dataset.price).toLocaleString("en-US") + "</b> نقطة؟");
    if (!ok) return; try { var r = await api("/api/buy", { itemId: b.dataset.buy }); toast(r.message); setPts(r.points); reload(); } catch (e) { toast(e.message); } }; });
  root.querySelectorAll("[data-eq]").forEach(function (b) { b.onclick = async function () { try { var r = await api("/api/equip", { itemId: b.dataset.eq }); toast(r.message); reload(); } catch (e) { toast(e.message); } }; });
}
function tabs() {
  var T = [["shop", "🛍️ المتجر"], ["inv", "🎒 مخزوني"], ["top", "🏆 التوب"], ["me", "👤 بروفايلي"]];
  $("tabs").innerHTML = T.map(function (t) { return '<button class="' + (tab === t[0] ? "on" : "") + '" data-t="' + t[0] + '">' + t[1] + "</button>"; }).join("");
  $("tabs").querySelectorAll("button").forEach(function (b) { b.onclick = function () { tab = b.dataset.t; go(); }; });
}
async function go() {
  tabs(); $("sub").innerHTML = ""; $("view").innerHTML = '<div class="msg">جاري التحميل...</div>';
  try {
    if (tab === "shop") await viewShop(); else if (tab === "inv") await viewInv(); else if (tab === "top") await viewTop(); else await viewMe();
  } catch (e) { $("view").innerHTML = '<div class="msg">' + esc(e.message) + "</div>"; }
}
async function viewShop() {
  if (!cats.length) { var s = await api("/api/shop"); cats = s.categories; setPts(s.points); }
  var chips = cats.map(function (c) { return '<button class="chip ' + (cat === c.id ? "on" : "") + '" data-c="' + c.id + '">' + c.emoji + " " + esc(c.label) + " (" + c.count + ")</button>"; }).join("") + '<button class="chip ' + (cat === "bundles" ? "on" : "") + '" data-c="bundles">🎁 الحزم</button>';
  $("sub").innerHTML = '<div class="chips">' + chips + "</div>";
  $("sub").querySelectorAll("[data-c]").forEach(function (b) { b.onclick = function () { cat = b.dataset.c; go(); }; });
  if (cat === "bundles") {
    var d = await api("/api/bundles"); setPts(d.points);
    $("view").innerHTML = '<div class="grid">' + d.bundles.map(function (b) {
      return '<div class="card bundle wide" style="border-color:#4aa3ff"><div class="off">-' + b.off + '%</div><div class="nm" style="padding-top:26px">' + esc(b.ar) + " — " + b.items.length + ' عناصر</div><div class="row">' + b.items.slice(0, 5).map(function (i) { return '<img src="' + img(i) + '">'; }).join("") + "</div>" +
        (b.allOwned ? '<div class="btn" style="opacity:.6">تملكها كلها</div>' : '<button class="btn buy" data-bb="' + b.id + '" data-n="' + esc(b.ar) + '" data-p="' + b.cost + '">' + Number(b.cost).toLocaleString("en-US") + COIN + (b.partial ? "" : ' <span class="old">' + Number(b.full).toLocaleString("en-US") + "</span>") + "</button>") + "</div>";
    }).join("") + "</div>";
    $("view").querySelectorAll("[data-bb]").forEach(function (b) { b.onclick = async function () {
      var ok = await confirmBox("شراء <b>" + b.dataset.n + "</b> مقابل <b>" + Number(b.dataset.p).toLocaleString("en-US") + "</b> نقطة؟"); if (!ok) return;
      try { var r = await api("/api/buy-bundle", { id: b.dataset.bb }); toast(r.message); setPts(r.points); go(); } catch (e) { toast(e.message); } }; });
    return;
  }
  var r = await api("/api/items?cat=" + cat); setPts(r.points);
  $("view").innerHTML = r.items.length ? '<div class="grid">' + r.items.map(function (i) { return card(i, "shop"); }).join("") + "</div>" : '<div class="empty">ما فيه عناصر بهذا القسم.</div>';
  bindActions($("view"), go);
}
async function viewInv() {
  var r = await api("/api/inventory"); setPts(r.points);
  $("view").innerHTML = r.items.length ? '<div class="grid">' + r.items.map(function (i) { return card(i, "inv"); }).join("") + "</div>" : '<div class="empty">مخزونك فاضي — جرّب المتجر!</div>';
  bindActions($("view"), go);
}
var topType = "points";
async function viewTop() {
  var chips = [["points", "💰 النقاط"], ["wins", "🏆 الفوز"], ["xp", "⭐ المستوى"]];
  $("sub").innerHTML = '<div class="chips">' + chips.map(function (c) { return '<button class="chip ' + (topType === c[0] ? "on" : "") + '" data-tt="' + c[0] + '">' + c[1] + "</button>"; }).join("") + "</div>";
  $("sub").querySelectorAll("[data-tt]").forEach(function (b) { b.onclick = function () { topType = b.dataset.tt; go(); }; });
  var r = await api("/api/top?type=" + topType);
  $("view").innerHTML = r.rows.length ? '<div class="list">' + r.rows.map(function (x) {
    return '<div class="rowx ' + (x.me ? "me" : "") + '"><div class="rk">' + (x.rank <= 3 ? ["🥇", "🥈", "🥉"][x.rank - 1] : "#" + x.rank) + "</div>" + (x.user.avatar ? '<img src="' + esc(x.user.avatar) + '">' : "") + '<div class="n">' + esc(x.user.name) + '</div><div class="v">' + Number(x.value).toLocaleString("en-US") + (topType === "points" ? COIN : "") + "</div></div>";
  }).join("") + "</div>" : '<div class="empty">ما فيه بيانات للحين.</div>';
}
async function viewMe() {
  var r = await api("/api/profile"); setPts(r.points);
  var S = [["النقاط", Number(r.points).toLocaleString("en-US")], ["المستوى", r.level], ["الترتيب العالمي", r.rank ? "#" + r.rank : "-"], ["الفوز", r.wins], ["الخسارة", r.losses], ["مباريات الروليت", r.plays], ["انتصارات المباراة", r.matchWins], ["الطرد", r.kicks]];
  var names = { banner: "البانر", badge: "الشارة", decoration: "الديكور", frame: "الإطار", title: "اللقب" };
  var eq = Object.keys(names).map(function (k) { return "<div>" + names[k] + ": <b>" + esc(r.equipped[k] || "—") + "</b></div>"; }).join("");
  $("view").innerHTML = '<div class="msg"><b style="font-size:20px;color:#fff">' + esc(r.name) + '</b></div><div class="stats">' + S.map(function (s) { return '<div class="stat"><b>' + s[1] + "</b><span>" + s[0] + "</span></div>"; }).join("") + '</div><div class="list"><div class="rowx" style="flex-direction:column;align-items:flex-start;gap:6px">' + eq + "</div></div>";
}
async function boot() {
  tabs();
  if (!inDiscord) { $("view").innerHTML = '<div class="msg">افتح هذا التطبيق من داخل ديسكورد (Activity).</div>'; return; }
  try {
    var mod = await import("/sdk.js");
    var sdk = new mod.DiscordSDK(CLIENT_ID);
    await sdk.ready();
    var auth = await sdk.commands.authorize({ client_id: CLIENT_ID, response_type: "code", state: "", prompt: "none", scope: ["identify"] });
    var r = await fetch(BASE + "/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: auth.code }) });
    var j = await r.json();
    if (!r.ok) throw new Error(j.error || "فشل تسجيل الدخول");
    await sdk.commands.authenticate({ access_token: j.access_token });
    session = j.session;
    await go();
  } catch (e) { console.error(e); $("view").innerHTML = '<div class="msg">تعذر بدء التطبيق: ' + esc(e.message || e) + "</div>"; }
}
boot();
</script>
</body>
</html>`;

module.exports = { startActivityServer };
