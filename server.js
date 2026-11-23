'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { q, tx } = require('./db');
const ai = require('./ai');
const billing = require('./billing');

const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 30);
const TRIAL_SEATS = Number(process.env.TRIAL_SEATS || 10);
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 150); // AI calls per person per day
const SESSION_DAYS = 14;
const DAY = 864e5;
const PUBLIC = path.join(__dirname, 'public');

const id = () => crypto.randomBytes(12).toString('hex');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const now = () => Date.now();
const fail = (status, message) => Object.assign(new Error(message), { status });

/* ---------- passwords ---------- */
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [v, salt, h] = String(stored).split('$');
  if (v !== 's1') return false;
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const validEmail = e => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validPw = p => typeof p === 'string' && p.length >= 10 && p.length <= 200;
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/* ---------- login throttling (in memory; fine for one server) ---------- */
const attempts = new Map();
function throttle(key) {
  const a = attempts.get(key) || { n: 0, t: now() };
  if (now() - a.t > 15 * 60e3) { a.n = 0; a.t = now(); }
  a.n++; attempts.set(key, a);
  if (a.n > 10) throw fail(429, 'Too many attempts. Please wait 15 minutes and try again.');
}

/* ---------- sessions ---------- */
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.run('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)', sha(token), userId, now() + SESSION_DAYS * DAY);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${PROD ? '; Secure' : ''}`);
}
function endSession(req, res) {
  const t = cookie(req).sid;
  if (t) q.run('DELETE FROM sessions WHERE token_hash=?', sha(t));
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${PROD ? '; Secure' : ''}`);
}
function cookie(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return o;
}
function auth(req) {
  const t = cookie(req).sid;
  if (!t) throw fail(401, 'Please sign in.');
  const r = q.one(`SELECT u.*, s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`, sha(t));
  if (!r || r.expires < now()) throw fail(401, 'Your session has ended. Please sign in again.');
  return r;
}
const manager = u => { if (u.role !== 'manager') throw fail(403, 'Only managers can do this.'); };

/* ---------- plan ---------- */
function plan(t) {
  const subscribed = ['active', 'trialing', 'past_due'].includes(t.sub_status);
  const trial = t.trial_ends_at > now();
  return {
    status: subscribed ? 'subscribed' : trial ? 'trial' : 'expired',
    subStatus: t.sub_status || null,
    trialEndsAt: t.trial_ends_at,
    seats: t.seats,
    access: subscribed || trial,
    billingEnabled: billing.enabled(),
    hasCustomer: !!t.stripe_customer_id,
  };
}
const tenantOf = u => q.one('SELECT * FROM tenants WHERE id=?', u.tenant_id);
const seatsUsed = tid => q.one('SELECT COUNT(*) n FROM users WHERE tenant_id=?', tid).n
  + q.one(`SELECT COUNT(*) n FROM tokens WHERE tenant_id=? AND kind='invite' AND expires>?`, tid, now()).n;

/* ---------- helpers ---------- */
function readBody(req, limit = 100_000) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { no(fail(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', no);
  });
}
async function json(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw fail(415, 'Expected JSON.');
  const raw = await readBody(req);
  try { const o = raw ? JSON.parse(raw) : {}; return o && typeof o === 'object' ? o : {}; }
  catch (e) { throw fail(400, 'Invalid JSON.'); }
}
const out = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};
const parse = s => { try { return JSON.parse(s); } catch (e) { return {}; } };
const limitJson = (o, n) => { const s = JSON.stringify(o ?? {}); if (s.length > n) throw fail(413, 'That is too large to save.'); return s; };

function meView(u) {
  const t = tenantOf(u);
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role },
    tenant: { id: t.id, name: t.name },
    plan: plan(t),
    config: parse(t.config),
    pilot: parse(t.pilot),
  };
}

function newTenantAndUser({ dealership, name, email, password }) {
  if (!clean(dealership, 100)) throw fail(400, 'Enter your dealership name.');
  if (!clean(name, 100)) throw fail(400, 'Enter your name.');
  if (!validEmail(email)) throw fail(400, 'Enter a valid email address.');
  if (!validPw(password)) throw fail(400, 'Use a password of at least 10 characters.');
  email = email.trim().toLowerCase();
  if (q.one('SELECT 1 x FROM users WHERE email=?', email)) throw fail(409, 'An account with that email already exists. Try signing in.');
  const tid = id(), uid = id();
  tx(() => {
    q.run('INSERT INTO tenants(id,name,created_at,trial_ends_at,seats) VALUES(?,?,?,?,?)',
      tid, clean(dealership, 100), now(), now() + TRIAL_DAYS * DAY, TRIAL_SEATS);
    q.run('INSERT INTO users(id,tenant_id,email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?,?,?)',
      uid, tid, email, clean(name, 100), hashPw(password), 'manager', now());
  });
  return uid;
}

function takeToken(raw, kind) {
  const t = q.one('SELECT * FROM tokens WHERE token_hash=? AND kind=?', sha(String(raw || '')), kind);
  if (!t || t.expires < now()) throw fail(400, 'This link has expired. Ask your manager for a new one.');
  return t;
}

/* ---------- AI ---------- */
function aiGate(u) {
  const t = tenantOf(u);
  if (!plan(t).access) throw fail(402, 'The trial has ended. Ask your manager to subscribe to keep using AI features.');
  const day = new Date().toISOString().slice(0, 10);
  const row = q.one('SELECT n FROM ai_calls WHERE user_id=? AND day=?', u.id, day);
  if (row && row.n >= AI_DAILY_LIMIT) throw fail(429, 'Daily AI limit reached. It resets tomorrow.');
  q.run('INSERT INTO ai_calls(user_id,day,n) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET n=n+1', u.id, day);
  return t;
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('POST', '/api/signup', async (req, res) => {
  throttle('signup:' + req.socket.remoteAddress);
  const uid = newTenantAndUser(await json(req));
  startSession(res, uid);
  out(res, 201, meView(q.one('SELECT * FROM users WHERE id=?', uid)));
});

route('POST', '/api/login', async (req, res) => {
  const b = await json(req), email = clean(b.email, 200).toLowerCase();
  throttle('login:' + email); throttle('loginip:' + req.socket.remoteAddress);
  const u = q.one('SELECT * FROM users WHERE email=?', email);
  if (!u || !checkPw(String(b.password || ''), u.pw_hash)) throw fail(401, 'Email or password is not right.');
  attempts.delete('login:' + email);
  startSession(res, u.id);
  out(res, 200, meView(u));
});

route('POST', '/api/logout', async (req, res) => { endSession(req, res); out(res, 200, { ok: true }); });
route('GET', '/api/me', async (req, res) => out(res, 200, meView(auth(req))));

route('GET', '/api/invite/:token', async (req, res, p) => {
  const t = takeToken(p.token, 'invite');
  out(res, 200, { email: t.email, dealership: q.one('SELECT name FROM tenants WHERE id=?', t.tenant_id).name });
});

route('POST', '/api/accept-invite', async (req, res) => {
  throttle('invite:' + req.socket.remoteAddress);
  const b = await json(req), t = takeToken(b.token, 'invite');
  if (!clean(b.name, 100)) throw fail(400, 'Enter your name.');
  if (!validPw(b.password)) throw fail(400, 'Use a password of at least 10 characters.');
  if (q.one('SELECT 1 x FROM users WHERE email=?', t.email)) throw fail(409, 'That email already has an account.');
  const uid = id();
  tx(() => {
    q.run('INSERT INTO users(id,tenant_id,email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?,?,?)',
      uid, t.tenant_id, t.email, clean(b.name, 100), hashPw(b.password), t.role, now());
    q.run('DELETE FROM tokens WHERE token_hash=?', t.token_hash);
  });
  startSession(res, uid);
  out(res, 201, meView(q.one('SELECT * FROM users WHERE id=?', uid)));
});

route('POST', '/api/reset', async (req, res) => {
  throttle('reset:' + req.socket.remoteAddress);
  const b = await json(req), t = takeToken(b.token, 'reset');
  if (!validPw(b.password)) throw fail(400, 'Use a password of at least 10 characters.');
  tx(() => {
    q.run('UPDATE users SET pw_hash=? WHERE id=?', hashPw(b.password), t.user_id);
    q.run('DELETE FROM sessions WHERE user_id=?', t.user_id);
    q.run('DELETE FROM tokens WHERE token_hash=?', t.token_hash);
  });
  out(res, 200, { ok: true });
});

/* team management (managers) */
route('GET', '/api/team', async (req, res) => {
  const u = auth(req); manager(u);
  out(res, 200, {
    members: q.all('SELECT id,name,email,role,created_at FROM users WHERE tenant_id=? ORDER BY created_at', u.tenant_id),
    invites: q.all(`SELECT email,role,expires FROM tokens WHERE tenant_id=? AND kind='invite' AND expires>? ORDER BY expires`, u.tenant_id, now()),
    seats: tenantOf(u).seats, used: seatsUsed(u.tenant_id),
  });
});

route('POST', '/api/invites', async (req, res) => {
  const u = auth(req); manager(u);
  const b = await json(req), email = clean(b.email, 200).toLowerCase(), role = b.role === 'manager' ? 'manager' : 'consultant';
  if (!validEmail(email)) throw fail(400, 'Enter a valid email address.');
  if (q.one('SELECT 1 x FROM users WHERE email=?', email)) throw fail(409, 'That email already has an account.');
  const t = tenantOf(u);
  if (seatsUsed(t.id) >= t.seats) throw fail(402, `All ${t.seats} seats are in use. Add seats in Billing to invite more people.`);
  q.run(`DELETE FROM tokens WHERE tenant_id=? AND kind='invite' AND email=?`, t.id, email);
  const token = crypto.randomBytes(24).toString('base64url');
  q.run(`INSERT INTO tokens(token_hash,kind,tenant_id,email,role,expires) VALUES(?,?,?,?,?,?)`, sha(token), 'invite', t.id, email, role, now() + 7 * DAY);
  out(res, 201, { link: `${process.env.APP_URL || ''}/?invite=${token}`, expiresInDays: 7 });
});

route('DELETE', '/api/invites', async (req, res) => {
  const u = auth(req); manager(u);
  const b = await json(req);
  q.run(`DELETE FROM tokens WHERE tenant_id=? AND kind='invite' AND email=?`, u.tenant_id, clean(b.email, 200).toLowerCase());
  out(res, 200, { ok: true });
});

route('POST', '/api/users/:id/reset', async (req, res, p) => {
  const u = auth(req); manager(u);
  const t = q.one('SELECT id FROM users WHERE id=? AND tenant_id=?', p.id, u.tenant_id);
  if (!t) throw fail(404, 'Person not found.');
  const token = crypto.randomBytes(24).toString('base64url');
  q.run(`INSERT INTO tokens(token_hash,kind,tenant_id,user_id,expires) VALUES(?,?,?,?,?)`, sha(token), 'reset', u.tenant_id, p.id, now() + DAY);
  out(res, 201, { link: `${process.env.APP_URL || ''}/?reset=${token}` });
});

route('PATCH', '/api/users/:id', async (req, res, p) => {
  const u = auth(req); manager(u);
  const b = await json(req), role = b.role === 'manager' ? 'manager' : 'consultant';
  const t = q.one('SELECT id,role FROM users WHERE id=? AND tenant_id=?', p.id, u.tenant_id);
  if (!t) throw fail(404, 'Person not found.');
  if (t.id === u.id && role !== 'manager') throw fail(400, 'You cannot remove your own manager access.');
  q.run('UPDATE users SET role=? WHERE id=?', role, p.id);
  out(res, 200, { ok: true });
});

route('DELETE', '/api/users/:id', async (req, res, p) => {
  const u = auth(req); manager(u);
  if (p.id === u.id) throw fail(400, 'You cannot remove yourself.');
  const r = q.run('DELETE FROM users WHERE id=? AND tenant_id=?', p.id, u.tenant_id);
  if (!r.changes) throw fail(404, 'Person not found.');
  out(res, 200, { ok: true });
});

/* dealership details and pilot */
route('PUT', '/api/config', async (req, res) => {
  const u = auth(req); manager(u);
  const b = await json(req), c = {};
  for (const f of ai.FD) c[f[0]] = clean(b[f[0]], 500);
  q.run('UPDATE tenants SET config=? WHERE id=?', JSON.stringify(c), u.tenant_id);
  out(res, 200, c);
});
route('PUT', '/api/pilot', async (req, res) => {
  const u = auth(req); manager(u);
  const b = await json(req), done = {};
  for (const k of ['cfg', 'share', 'try', 'review', 'feed']) done[k] = !!(b.done && b.done[k]);
  const p = { done, goal: clean(b.goal, 600), start: /^\d{4}-\d{2}-\d{2}$/.test(b.start) ? b.start : '', days: [30, 45, 60].includes(+b.days) ? +b.days : 30 };
  q.run('UPDATE tenants SET pilot=? WHERE id=?', JSON.stringify(p), u.tenant_id);
  out(res, 200, p);
});

/* history (private to each person) */
route('GET', '/api/history', async (req, res) => {
  const u = auth(req);
  out(res, 200, q.all('SELECT id,ts,data FROM history WHERE user_id=? ORDER BY ts DESC LIMIT 50', u.id).map(r => ({ id: r.id, ts: r.ts, ...parse(r.data) })));
});
route('POST', '/api/history', async (req, res) => {
  const u = auth(req), b = await json(req), i = id();
  q.run('INSERT INTO history(id,tenant_id,user_id,ts,data) VALUES(?,?,?,?,?)', i, u.tenant_id, u.id, now(), limitJson({ obj: clean(b.obj, 600), r: b.r, c: b.c }, 20000));
  q.run('DELETE FROM history WHERE user_id=? AND id NOT IN (SELECT id FROM history WHERE user_id=? ORDER BY ts DESC LIMIT 200)', u.id, u.id);
  out(res, 201, { id: i });
});
route('DELETE', '/api/history/:id', async (req, res, p) => {
  const u = auth(req);
  q.run('DELETE FROM history WHERE id=? AND user_id=?', p.id, u.id);
  out(res, 200, { ok: true });
});

/* team library (shared inside the dealership) */
route('GET', '/api/library', async (req, res) => {
  const u = auth(req);
  out(res, 200, q.all('SELECT l.id,l.ts,l.ind,l.obj,l.data,l.user_id,u.name by_name FROM library l JOIN users u ON u.id=l.user_id WHERE l.tenant_id=? ORDER BY l.ts DESC LIMIT 200', u.tenant_id)
    .map(r => ({ id: r.id, ts: r.ts, ind: r.ind, obj: r.obj, by: r.user_id, byName: r.by_name, r: parse(r.data) })));
});
route('POST', '/api/library', async (req, res) => {
  const u = auth(req), b = await json(req), i = id();
  if (!clean(b.obj, 600) || !b.r) throw fail(400, 'Nothing to share.');
  q.run('INSERT INTO library(id,tenant_id,user_id,ts,ind,obj,data) VALUES(?,?,?,?,?,?,?)', i, u.tenant_id, u.id, now(), ai.IND[b.ind] ? b.ind : 'auto', clean(b.obj, 600), limitJson(b.r, 20000));
  out(res, 201, { id: i });
});
route('DELETE', '/api/library/:id', async (req, res, p) => {
  const u = auth(req);
  q.run(`DELETE FROM library WHERE id=? AND tenant_id=? AND (user_id=? OR ?='manager')`, p.id, u.tenant_id, u.id, u.role);
  out(res, 200, { ok: true });
});

/* usage events and insights */
route('POST', '/api/usage', async (req, res) => {
  const u = auth(req), b = await json(req);
  if (!['coach', 'practice', 'rating'].includes(b.type)) throw fail(400, 'Unknown event.');
  const e = { type: b.type, key: clean(b.key, 80), ind: ai.IND[b.ind] ? b.ind : 'auto' };
  if (b.type === 'coach') { e.cat = clean(b.cat, 40); e.src = b.src === 'AI' ? 'AI' : 'Library'; }
  if (b.type === 'practice' && Array.isArray(b.scores) && b.scores.length === 5) e.scores = b.scores.map(n => Math.max(0, Math.min(5, Math.round(+n) || 0)));
  if (b.type === 'rating') e.up = b.up ? 1 : 0;
  q.run('INSERT INTO usage(tenant_id,user_id,ts,data) VALUES(?,?,?,?)', u.tenant_id, u.id, now(), JSON.stringify(e));
  out(res, 201, { ok: true });
});
route('GET', '/api/usage', async (req, res) => {
  const u = auth(req); manager(u);
  const rows = q.all('SELECT x.user_id,x.ts,x.data,u.name FROM usage x JOIN users u ON u.id=x.user_id WHERE x.tenant_id=? ORDER BY x.ts DESC LIMIT 5000', u.tenant_id);
  out(res, 200, rows.map(r => ({ ...parse(r.data), uid: r.user_id, name: r.name, ts: r.ts })));
});

/* AI */
route('POST', '/api/ai', async (req, res) => {
  const u = auth(req), b = await json(req), t = aiGate(u);
  if (b.task === 'coach') {
    if (!clean(b.obj, 600)) throw fail(400, 'Enter the objection first.');
    return out(res, 200, { result: await ai.coach(b, parse(t.config)) });
  }
  if (b.task === 'practice') return out(res, 200, await ai.practice(b));
  if (b.task === 'feedback') return out(res, 200, await ai.feedback(b));
  throw fail(400, 'Unknown task.');
});

/* billing */
route('POST', '/api/billing/checkout', async (req, res) => {
  const u = auth(req); manager(u);
  if (!billing.enabled()) throw fail(503, 'Billing is not set up yet.');
  const t = tenantOf(u), b = await json(req);
  if (['active', 'trialing', 'past_due'].includes(t.sub_status)) throw fail(400, 'You already have a subscription. Use Manage billing.');
  const seats = Math.max(1, Math.min(500, Math.round(+b.seats || seatsUsed(t.id))));
  out(res, 200, { url: await billing.checkoutUrl(t, u.email, seats) });
});
route('POST', '/api/billing/portal', async (req, res) => {
  const u = auth(req); manager(u);
  const t = tenantOf(u);
  if (!billing.enabled() || !t.stripe_customer_id) throw fail(400, 'No billing account yet.');
  out(res, 200, { url: await billing.portalUrl(t) });
});
route('POST', '/api/stripe/webhook', async (req, res) => {
  const raw = await readBody(req, 1_000_000);
  if (!billing.verify(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) throw fail(400, 'Bad signature.');
  await billing.handleEvent(parse(raw));
  out(res, 200, { received: true });
});

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let f = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC, decodeURIComponent(f)));
  if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.');
      return serveStatic(req, res, url.pathname);
    }
    if (url.pathname === '/api/health') return out(res, 200, { ok: true });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) return await r.fn(req, res, m.groups || {});
    }
    throw fail(404, 'Not found.');
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) out(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on our side.' });
  }
});

if (require.main === module) {
  if (PROD && !process.env.APP_URL) console.warn('Warning: set APP_URL (your https address) so invite and billing links work.');
  server.listen(PORT, () => console.log(`ALERT Coach listening on :${PORT}`));
}
module.exports = { server };
