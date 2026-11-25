'use strict';
/* ALERT Objection Coach: browser app. Uses data.js (libraries, industries, buyer types, dealership fields). */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { me: null, cfg: {}, pilot: { done: {}, goal: '', start: '', days: 30 }, hist: [], team: [], use: [], members: null, res: null, obj: '', lt: null, rk: '', rated: false, chat: [], busy: false, link: '' };
let C = IND.auto, LIB = LIB_AUTO;

async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) { /* empty body */ }
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.status = r.status; throw e; }
  return j;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.className = 'on'; clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 2200); }
const isMgr = () => S.me && S.me.user.role === 'manager';
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { if (e.status === 401) location.reload(); else toast(e.message); } };

/* ---------- sign in / sign up ---------- */
function authView(v) {
  document.querySelectorAll('.auth form').forEach(f => f.classList.toggle('on', f.id === 'f-' + v));
  $('#authSub').textContent = { login: 'Sign in to your dealership account.', signup: 'Start a free trial for your dealership.', invite: 'You’ve been invited to join your dealership.', reset: 'Reset your password.' }[v];
  $('#authErr').textContent = '';
}
const FORMS = {
  async login() { enter(await api('POST', '/api/login', { email: $('#l-email').value, password: $('#l-pw').value })); },
  async signup() { enter(await api('POST', '/api/signup', { dealership: $('#s-deal').value, name: $('#s-name').value, email: $('#s-email').value, password: $('#s-pw').value })); },
  async invite() { enter(await api('POST', '/api/accept-invite', { token: S.token, name: $('#i-name').value, password: $('#i-pw').value })); },
  async reset() { await api('POST', '/api/reset', { token: S.token, password: $('#r-pw').value }); history.replaceState(null, '', '/'); authView('login'); $('#authErr').textContent = 'Password updated. Please sign in.'; },
};
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault(); $('#authErr').textContent = '';
  try { await FORMS[f.dataset.form](); } catch (err) { $('#authErr').textContent = err.message; }
});

async function signout() { try { await api('POST', '/api/logout', {}); } catch (e) { /* ignore */ } location.href = '/'; }

/* ---------- entering the app ---------- */
function showAuth(v) { $('#app').hidden = true; $('#auth').hidden = false; authView(v); }
async function enter(me) {
  S.me = me; S.cfg = me.config || {}; S.pilot = Object.assign({ done: {}, goal: '', start: '', days: 30 }, me.pilot || {});
  history.replaceState(null, '', '/');
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#who').textContent = me.user.name + ' · ' + me.tenant.name + ' · ' + (isMgr() ? 'Manager' : 'Sales consultant');
  document.querySelectorAll('[data-mgr]').forEach(b => b.style.display = isMgr() ? '' : 'none');
  $('#ind').innerHTML = Object.keys(IND).map(k => `<option value="${k}">${esc(IND[k].n)}</option>`).join('');
  let sv = 'auto'; try { sv = localStorage.getItem('ind') || 'auto'; } catch (e) { /* ignore */ }
  setInd(sv);
  renderBanner(); renderSetup(); renderPilot(); renderTeam();
  await Promise.all([loadHist(), loadTeamLib(), isMgr() ? loadUse() : 0].filter(Boolean).map(p => p.catch(() => {})));
  if (new URLSearchParams(location.search).get('billing') === 'success') toast('Thanks! Your subscription is being activated.');
}
function renderBanner() {
  const p = S.me.plan, el = $('#banner');
  if (p.status === 'trial') {
    const d = Math.max(0, Math.ceil((p.trialEndsAt - Date.now()) / 864e5));
    el.innerHTML = `<div class="banner">Free trial: ${d} day${d === 1 ? '' : 's'} left.${isMgr() ? ' <button class="link" data-act="tab" data-v="team">Subscribe</button>' : ''}</div>`;
  } else if (p.status === 'expired') {
    el.innerHTML = `<div class="banner warn">The trial has ended, so AI features are paused. ${isMgr() ? '<button class="link" data-act="tab" data-v="team">Subscribe to continue</button>' : 'Ask your manager to subscribe.'}</div>`;
  } else el.innerHTML = '';
}

/* ---------- tabs and industry ---------- */
function show(v) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('#app section').forEach(s => s.classList.toggle('on', s.id === v));
  if (v === 'ins' || v === 'pilot') loadUse().catch(() => {}); if (v === 'team') loadTeam();
  if (v === 'lib') loadTeamLib().catch(() => {});
}
function setInd(k) {
  if (!IND[k]) k = 'auto'; C = IND[k]; C.k = k; LIB = C.lib; try { localStorage.setItem('ind', k); } catch (e) { /* ignore */ }
  $('#ind').value = k;
  document.querySelector('label[for=prod]').textContent = C.pl; $('#prod').placeholder = C.pp;
  document.querySelector('label[for=role]').textContent = C.rl; $('#obj').placeholder = C.op;
  $('#role').innerHTML = '<option value="">Not specified</option>' + (ROLES[k] || ROLES.b2b).map(g => `<optgroup label="${esc(g[0])}">` + g[1].map(x => `<option>${esc(x)}</option>`).join('') + '</optgroup>').join('');
  $('#stage').innerHTML = C.st.map((x, i) => `<option${i === 2 ? ' selected' : ''}>${esc(x)}</option>`).join('');
  $('#pers').innerHTML = C.pe.map(x => `<option>${esc(x)}</option>`).join('');
  $('#sub').textContent = 'Acknowledge · Listen · Explore · Respond · Test — turn any ' + C.n.toLowerCase() + ' objection into a response you can use.';
  const cs = [...new Set(LIB.map(e => e.c).filter(Boolean))];
  $('#cat').innerHTML = cs.length ? '<option value="">All categories</option>' + cs.map(c => `<option>${esc(c)}</option>`).join('') : '';
  $('#cat').style.display = cs.length ? '' : 'none';
  document.querySelector('#nav [data-v="setup"]').style.display = k === 'auto' ? '' : 'none';
  renderLib(); renderSetup(); fillPlib();
}

/* ---------- dealership details ---------- */
const fill = t => String(t == null ? '' : t).replace(/\{\{(\w+)\}\}/g, (m, k) => ((S.cfg[k] || '').trim() || '[' + (LBL[k] || k) + ']'));
function renderSetup() {
  const bn = [(S.cfg.dealer || '').trim(), (S.cfg.market || '').trim()].filter(Boolean).join(' · '); $('#brand').textContent = C.k === 'auto' && bn ? bn : '';
  const el = $('#sform');
  if (!el.dataset.b) { el.dataset.b = 1; el.innerHTML = FD.map(([k, l, t, p]) => `<label>${l}</label>` + (t === 's' ? `<select data-k="${k}"><option value="">Choose…</option>${p.map(o => `<option>${esc(o)}</option>`).join('')}</select>` : t === 'i' ? `<input data-k="${k}" maxlength="500" placeholder="${esc(p)}">` : `<textarea data-k="${k}" maxlength="500" placeholder="${esc(p)}"></textarea>`)).join(''); }
  el.querySelectorAll('[data-k]').forEach(i => { if (document.activeElement !== i) i.value = S.cfg[i.dataset.k] || ''; i.disabled = !isMgr(); });
  $('#ssave').style.display = isMgr() ? '' : 'none';
  $('#snote').textContent = isMgr() ? 'Fill these in once. Choose your market first: it sets the currency, spelling and rules the AI writes for. These details complete the answers for every sales consultant.' : 'Only managers can edit these details. They complete the answers you see.';
}
const saveCfg = guard(async () => {
  const c = {}; document.querySelectorAll('#sform [data-k]').forEach(i => c[i.dataset.k] = i.value.trim());
  S.cfg = await api('PUT', '/api/config', c); renderSetup(); renderPilot(); toast('Saved');
});

/* ---------- coach ---------- */
const ctx = () => ({ prod: $('#prod').value.trim(), role: $('#role').value, stage: $('#stage').value, said: $('#said').value.trim(), tone: $('#tone').value, comp: $('#comp').value.trim(), research: $('#research').checked });
function match(t) { t = t.toLowerCase(); let b = null, n = 0; LIB.forEach(e => { const s = e.k.filter(k => t.includes(k)).length; if (s > n) { n = s; b = e; } }); return b; }
const fromLib = e => ({ a: e.a, l: e.l, e: e.e, r: e.r, t: e.t, src: 'Library' });
const gen = guard(async force => {
  const obj = $('#obj').value.trim(); if (!obj) { toast('Enter an objection first'); return; }
  const comp = $('#comp').value.trim(), mode = force === true || comp ? 'ai' : $('#mode').value, m = mode === 'ai' ? null : match(obj);
  if (m) { setRes(fromLib(m), obj, m.n); return; }
  if (mode === 'lib') { toast('No close library match — try Hybrid or AI'); return; }
  const b = $('#go'); b.disabled = true; b.textContent = comp && $('#research').checked ? 'Researching the market…' : 'Thinking…';
  try { const j = await api('POST', '/api/ai', { task: 'coach', obj, ind: C.k, ctx: ctx() }); setRes(j.result, obj); }
  finally { b.disabled = false; b.textContent = 'Get ALERT response'; }
});
function setRes(r, obj, lt) {
  S.res = r; S.obj = obj; S.lt = lt; S.rated = false; S.rk = (lt || obj.slice(0, 50).toLowerCase());
  renderRes();
  api('POST', '/api/history', { obj, r, c: ctx() }).then(loadHist).catch(() => {});
  const e = lt ? LIB.find(x => x.n === lt) : match(obj);
  logUse({ type: 'coach', key: e ? e.n : obj.slice(0, 50).toLowerCase(), cat: (e && e.c) || 'Other', src: r.src, ind: C.k });
}
function intelHtml(r) {
  const m = r.m; if (!m) return '';
  const cs = m.competitors.map(c => `<div class="ci"><b>${esc(c.name)}</b><ul>${c.points.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('');
  const of = m.offers.length ? `<b>Offers and incentives found</b><ul>${m.offers.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const src = m.sources && m.sources.length ? `<div class="note">Sources: ${m.sources.filter(x => /^https:\/\//.test(x.url)).map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>`).join(' · ')}</div>` : '';
  const status = m.researched ? 'Researched online just now.' : 'Live research was not available, so this is general knowledge only.';
  return `<div class="card intel"><div class="sh"><b>Market intel: ${esc(m.asked)}</b><button class="ghost" data-act="cp" data-k="intel">Copy</button></div><p class="note">For you, not to read out. ${status} Check every price and offer before quoting it.</p>${cs}${of}${m.caveat ? `<p class="note">${esc(m.caveat)}</p>` : ''}${src}</div>`;
}
const intelText = r => { const m = r.m; return m ? 'Market intel: ' + m.asked + '\n' + m.competitors.map(c => c.name + '\n- ' + c.points.join('\n- ')).join('\n') + (m.offers.length ? '\nOffers:\n- ' + m.offers.join('\n- ') : '') + (m.caveat ? '\n' + m.caveat : '') : ''; };
const ST = [['A', 'Acknowledge', 'a'], ['L', 'Listen', 'l'], ['E', 'Explore', 'e'], ['R', 'Respond', 'r'], ['T', 'Test', 't']];
const qt = t => '“' + String(t == null ? '' : t).trim().replace(/^["“”]+|["“”]+$/g, '') + '”';
const disp = (r, k) => k === 'l' ? `<em class="do">${esc(fill(r.l))}</em>` : k === 'e' ? '<ol>' + r.e.map(x => '<li>' + esc(qt(fill(x))) + '</li>').join('') + '</ol>' : esc(qt(fill(r[k])));
const stx = (r, k) => k === 'e' ? r.e.map((x, i) => (i + 1) + '. ' + qt(fill(x))).join('\n') : k === 'l' ? '(Action: ' + fill(r.l) + ')' : qt(fill(r[k]));
function renderRes() {
  const r = S.res; if (!r) return;
  $('#out').innerHTML = `<div class="meta"><span class="tag">${r.src === 'AI' ? 'AI-generated' : 'From library' + (S.lt ? ': ' + esc(S.lt) : '')}</span><span class="q">${esc(S.obj)}</span></div><p class="key">“Quotation marks” = say this to the customer &nbsp;·&nbsp; <em>Italics</em> = something for you to do</p>` +
    ST.map(([L, n, k]) => `<div class="step"><div class="badge">${L}</div><div class="sb"><div class="sh"><b>${n}</b><button class="ghost" data-act="cp" data-k="${k}">Copy</button></div><div class="st">${disp(r, k)}</div></div></div>`).join('') +
    intelHtml(r) + `<div class="row"><button class="ghost" data-act="cp" data-k="all">Copy all</button>${r.src !== 'AI' ? '<button class="ghost" data-act="gen" data-force="1">Tailor with AI</button>' : ''}<button class="ghost" data-act="share">Share to team library</button><button class="ghost" data-act="practiseThis">Practise this</button></div>` +
    `<div class="row" id="rate">${S.rated ? '<span class="note">Thanks for the feedback.</span>' : '<span class="note">Was this response useful?</span><button class="ghost" data-act="rate" data-v="1">Useful</button><button class="ghost" data-act="rate" data-v="0">Not really</button>'}</div>`;
  $('#out').scrollIntoView({ behavior: 'smooth' });
}
async function copy(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); toast('Copied'); } catch (_) { toast('Copy not available'); } a.remove(); } }
function cp(k) { const r = S.res; copy(k === 'intel' ? intelText(r) : k === 'all' ? ST.map(([L, n, x]) => n + ':\n' + stx(r, x)).join('\n\n') + (r.m ? '\n\n' + intelText(r) : '') : stx(r, k)); }
function rate(v) { if (S.rated) return; S.rated = true; logUse({ type: 'rating', key: S.rk || S.obj.slice(0, 50).toLowerCase(), up: v, ind: C.k }); $('#rate').innerHTML = '<span class="note">Thanks for the feedback.</span>'; }
const share = guard(async () => { await api('POST', '/api/library', { obj: S.obj, r: S.res, ind: C.k }); toast('Shared with your team'); await loadTeamLib(); });
function logUse(o) { api('POST', '/api/usage', o).catch(() => {}); }

/* ---------- history and team library ---------- */
async function loadHist() { S.hist = await api('GET', '/api/history'); renderHist(); }
function renderHist() {
  $('#histList').innerHTML = S.hist.length ? S.hist.map((h, i) => `<div class="card"><div class="q">${esc(h.obj)}</div><div class="note">${new Date(h.ts).toLocaleString()} · ${esc(h.r && h.r.src)}</div><div class="row"><button class="ghost" data-act="openH" data-i="${i}">Open</button><button class="ghost" data-act="delH" data-i="${i}">Delete</button></div></div>`).join('') : '<p class="note">Nothing yet — your generated responses will appear here.</p>';
}
function openH(d) { const h = S.hist[+d.i]; $('#obj').value = h.obj; S.res = h.r; S.obj = h.obj; S.lt = null; S.rated = true; show('coach'); renderRes(); }
const delH = guard(async d => { await api('DELETE', '/api/history/' + S.hist[+d.i].id); await loadHist(); });
async function loadTeamLib() { S.team = await api('GET', '/api/library'); renderLib(); fillPlib(); }
function renderLib() {
  const q = $('#q').value.toLowerCase(), cat = $('#cat').value;
  const all = LIB.map((e, i) => ({ k: 'b', i, o: e.o, t: e.n, c: e.c || '' })).concat(S.team.map((e, i) => ({ k: 't', i, o: e.obj, t: 'Shared by team', ind: e.ind || 'auto' })).filter(x => x.ind === C.k));
  $('#libList').innerHTML = all.filter(x => (x.o + x.t).toLowerCase().includes(q) && (!cat || (x.k === 'b' && x.c === cat))).map(x => {
    const mine = x.k === 't' && (S.team[x.i].by === S.me.user.id || isMgr());
    return `<div class="card"><span class="tag">${x.k === 'b' ? 'Built-in' + (x.c ? ' · ' + esc(x.c) : '') : 'Team · ' + esc(S.team[x.i].byName)}</span><p class="q">${esc(x.o)}</p><div class="row"><button class="ghost" data-act="useL" data-k="${x.k}" data-i="${x.i}">View ALERT response</button><button class="ghost" data-act="practiseL" data-k="${x.k}" data-i="${x.i}">Practise</button>${mine ? `<button class="ghost" data-act="delT" data-i="${x.i}">Remove</button>` : ''}</div></div>`;
  }).join('') || '<p class="note">No matches.</p>';
}
function useL(d) { const o = d.k === 'b' ? LIB[+d.i] : null; $('#obj').value = o ? o.o : S.team[+d.i].obj; S.res = o ? fromLib(o) : S.team[+d.i].r; S.obj = $('#obj').value; S.lt = o ? o.n : 'team'; S.rated = true; show('coach'); renderRes(); }
const delT = guard(async d => { await api('DELETE', '/api/library/' + S.team[+d.i].id); await loadTeamLib(); });

/* ---------- practice ---------- */
function fillPlib() {
  const sel = $('#plib'); if (!sel) return;
  const groups = {};
  LIB.forEach(e => { (groups[e.c || 'Library'] = groups[e.c || 'Library'] || []).push(e.o); });
  const team = S.team.filter(x => (x.ind || 'auto') === C.k).map(x => x.obj);
  sel.innerHTML = '<option value="">Choose from the library…</option>' +
    Object.entries(groups).map(([g, os]) => `<optgroup label="${esc(g)}">` + os.map(o => `<option>${esc(o)}</option>`).join('') + '</optgroup>').join('') +
    (team.length ? '<optgroup label="Shared by your team">' + team.map(o => `<option>${esc(o)}</option>`).join('') + '</optgroup>' : '');
}
const renderChat = () => $('#chat').innerHTML = S.chat.map(m => `<div class="msg ${m.w}">${esc(m.t)}</div>`).join('');
function startP(o) {
  if (typeof o === 'string') $('#pobj').value = o;
  const ob = $('#pobj').value.trim(); if (!ob) { toast('Enter an objection'); return; }
  show('prac'); S.chat = [{ w: 'c', t: ob }]; $('#fb').style.display = 'none'; $('#pin').style.display = 'block'; renderChat();
}
const sendP = guard(async () => {
  const t = $('#pmsg').value.trim(); if (!t || S.busy) return;
  S.chat.push({ w: 'r', t }); $('#pmsg').value = ''; renderChat(); S.busy = true; $('#psend').disabled = true;
  try { const j = await api('POST', '/api/ai', { task: 'practice', ind: C.k, objection: $('#pobj').value, persona: $('#pers').value, chat: S.chat }); S.chat.push({ w: 'c', t: j.text }); }
  finally { S.busy = false; $('#psend').disabled = false; renderChat(); }
});
const fbP = guard(async () => {
  if (S.chat.length < 2) { toast('Reply to the client first'); return; }
  const f = $('#fb'); f.style.display = 'block'; f.textContent = 'Reviewing…';
  try {
    const j = await api('POST', '/api/ai', { task: 'feedback', ind: C.k, chat: S.chat }); f.textContent = j.text;
    if (j.scores) logUse({ type: 'practice', scores: j.scores, key: $('#pobj').value.slice(0, 50).toLowerCase(), ind: C.k });
  } catch (e) { f.textContent = e.message; }
});

/* ---------- insights (managers) ---------- */
async function loadUse() { S.use = await api('GET', '/api/usage'); renderIns(); renderPilot(); }
function renderIns() {
  if (!isMgr()) return;
  const d = +$('#iper').value, now = Date.now();
  const U = S.use.filter(u => u.ind === C.k && (!d || now - u.ts < d * 864e5)), co = U.filter(u => u.type === 'coach'), pr = U.filter(u => u.type === 'practice'), rt = U.filter(u => u.type === 'rating');
  const cnt = (a, f) => { const m = {}; a.forEach(x => { const k = f(x); m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const bars = (rows, max, fmt) => rows.map(([n, v]) => `<div class="br"><span>${esc(n)}</span><div class="bt"><i style="width:${Math.max(4, v / max * 100)}%"></i></div><b>${fmt ? fmt(v) : v}</b></div>`).join('') || '<p class="note">No data yet.</p>';
  const ids = [...new Set(U.map(u => u.uid))], topO = cnt(co, x => x.key).slice(0, 8), topC = cnt(co, x => x.cat);
  const sc = ['Acknowledge', 'Listen', 'Explore', 'Respond', 'Test'].map((n, i) => [n, pr.length ? pr.reduce((s, x) => s + ((x.scores || [])[i] || 0), 0) / pr.length : 0]);
  const low = pr.length ? sc.slice().sort((a, b) => a[1] - b[1])[0][0] : null;
  const up = rt.filter(x => x.up).length, dn = cnt(rt.filter(x => !x.up), x => x.key).slice(0, 5);
  const rows = ids.map(id => { const c = co.filter(x => x.uid === id).length, p = pr.filter(x => x.uid === id), a = p.length ? (p.reduce((s, x) => s + (x.scores || []).reduce((m, n) => m + n, 0) / 5, 0) / p.length).toFixed(1) : '–'; const nm = (U.find(x => x.uid === id) || {}).name || 'Sales consultant'; return `<tr><td>${esc(nm)}</td><td>${c}</td><td>${p.length}</td><td>${a}</td></tr>`; }).join('');
  $('#insOut').innerHTML = `<div class="g"><div class="card"><b>${co.length}</b><div class="note">responses generated</div></div><div class="card"><b>${ids.length}</b><div class="note">active sales consultants · ${pr.length} practice sessions</div></div></div>` +
    `<div class="card"><b>Most common objections</b>${bars(topO, topO[0] ? topO[0][1] : 1)}</div><div class="card"><b>By category</b>${bars(topC, topC[0] ? topC[0][1] : 1)}</div>` +
    `<div class="card"><b>Average practice score by ALERT step (out of 5)</b>${bars(sc, 5, v => v ? v.toFixed(1) : '–')}${low ? `<p class="note">Coaching focus: <b>${low}</b> is the weakest step.</p>` : ''}</div>` +
    `<div class="card"><b>Sales consultant feedback</b>${rt.length ? `<p style="margin:6px 0"><b>${Math.round(up / rt.length * 100)}%</b> of ${rt.length} ratings said the response was useful.</p>` : '<p class="note">No ratings yet.</p>'}${dn.length ? `<div class="note">Most often rated not useful:</div>${bars(dn, dn[0][1])}` : ''}</div>` +
    `<div class="card" style="overflow-x:auto"><b>By sales consultant</b><table><tr><th>Sales consultant</th><th>Responses</th><th>Practice</th><th>Avg score</th></tr>${rows}</table></div>`;
}

/* ---------- pilot (managers) ---------- */
const PST = [['cfg', 'Add your dealership details', 'Dealership tab: brands, models, offers, warranty and after-sales. These fill in every answer.'], ['share', 'Invite your sales team', 'Use the Team & billing tab to send invite links. Sales consultants get their own login.'], ['try', 'Every sales consultant generates 3 responses and does 1 practice session', 'Progress shows below.'], ['review', 'Review Team insights each week', 'Look at the most common objections and the weakest ALERT step, then coach on it.'], ['feed', 'Collect feedback at the end', 'Ask sales consultants what helped, what didn’t, and what they would pay.']];
function renderPilot() {
  if (!isMgr()) return;
  const P = S.pilot, filled = FD.filter(f => (S.cfg[f[0]] || '').trim()).length, by = {};
  S.use.filter(u => u.ind === 'auto').forEach(u => { const b = by[u.uid] = by[u.uid] || { c: 0, p: 0 }; if (u.type === 'coach') b.c++; if (u.type === 'practice') b.p++; });
  const a = Object.values(by), ready = a.filter(x => x.c >= 3 && x.p >= 1).length, st = { cfg: filled >= 5, try: a.length > 0 && ready === a.length };
  const isDone = k => k in st ? st[k] : !!P.done[k], n = PST.filter(x => isDone(x[0])).length;
  let left = ''; if (P.start) { const d = Math.ceil((new Date(P.start).getTime() + P.days * 864e5 - Date.now()) / 864e5); left = d > 0 ? d + ' days left in the pilot' : 'Pilot period ended; time to review results'; }
  $('#pilotOut').innerHTML = `<div class="card"><b>Pilot progress</b><div class="prog"><i style="width:${n / PST.length * 100}%"></i></div><div class="note">${n} of ${PST.length} steps done${left ? ' · ' + esc(left) : ''}</div></div>` +
    `<div class="card"><b>Setup checklist</b>${PST.map(([k, t, d]) => `<label class="chk" style="color:var(--ink);font-size:15px"><input type="checkbox" data-pk="${k}" ${isDone(k) ? 'checked' : ''} ${k in st ? 'disabled' : ''}><span>${esc(t)}<br><span class="note">${esc(d)}${k === 'cfg' ? ' (' + filled + ' of ' + FD.length + ' fields filled)' : ''}${k === 'try' ? ' (' + ready + ' of ' + a.length + ' active sales consultants there)' : ''}</span></span></label>`).join('')}</div>` +
    `<div class="card"><b>Pilot details</b><div class="g"><div><label for="pstart">Start date</label><input id="pstart" type="date" value="${esc(P.start)}"></div><div><label for="pdays">Length</label><select id="pdays">${[30, 45, 60].map(d => `<option${P.days == d ? ' selected' : ''}>${d}</option>`).join('')}</select></div></div><label for="pgoal">What would make this pilot a success?</label><textarea id="pgoal" maxlength="600" placeholder="e.g. Sales consultants use it twice a week and managers see fewer lost deals on price">${esc(P.goal)}</textarea><button class="p" data-act="savePilot">Save pilot details</button></div>`;
}
const persistPilot = guard(async () => { S.pilot = await api('PUT', '/api/pilot', S.pilot); renderPilot(); });
const savePilot = guard(async () => { S.pilot.start = $('#pstart').value; S.pilot.days = +$('#pdays').value || 30; S.pilot.goal = $('#pgoal').value.trim(); S.pilot = await api('PUT', '/api/pilot', S.pilot); renderPilot(); toast('Saved'); });
document.addEventListener('change', e => {
  const c = e.target.closest('[data-pk]'); if (c) { S.pilot.done[c.dataset.pk] = c.checked; persistPilot(); return; }
  const r = e.target.closest('[data-role]'); if (r) guard(async () => { await api('PATCH', '/api/users/' + r.dataset.role, { role: r.value }); toast('Updated'); await loadTeam(); })();
  if (e.target.id === 'ind') setInd(e.target.value);
  if (e.target.id === 'cat') renderLib();
  if (e.target.id === 'plib' && e.target.value) { $('#pobj').value = e.target.value; e.target.value = ''; $('#pobj').focus(); }
  if (e.target.id === 'iper') renderIns();
});
document.addEventListener('input', e => { if (e.target.id === 'q') renderLib(); });

/* ---------- team and billing (managers) ---------- */
const loadTeam = guard(async () => { if (!isMgr()) return; S.members = await api('GET', '/api/team'); renderTeam(); });
function renderTeam() {
  if (!isMgr()) return;
  const p = S.me.plan, T = S.members;
  const trial = p.status === 'trial' ? `Free trial until ${new Date(p.trialEndsAt).toLocaleDateString()}` : p.status === 'subscribed' ? 'Subscribed' + (p.subStatus === 'past_due' ? ' (payment overdue)' : '') : 'Trial ended';
  let html = `<div class="card"><b>Plan</b><p style="margin:6px 0">${esc(trial)} · ${p.seats} seats</p>`;
  if (!p.billingEnabled) html += '<p class="note">Billing is not set up on this server yet.</p>';
  else if (p.status === 'subscribed') html += '<button class="p" data-act="portal">Manage billing</button>';
  else html += `<label for="bseats">Seats (one per person)</label><input id="bseats" type="number" min="1" max="500" value="${Math.max(1, T ? T.used : 1)}" style="max-width:120px"><button class="p" data-act="checkout">Subscribe</button>` + (p.hasCustomer ? ' <button class="ghost" data-act="portal">Billing history</button>' : '');
  html += '</div>';
  if (T) {
    html += `<div class="card"><b>People</b> <span class="note">(${T.used} of ${T.seats} seats used)</span>` + T.members.map(m => `<div class="row" style="align-items:center;margin:10px 0"><div style="flex:1;min-width:150px">${esc(m.name)}<br><span class="note">${esc(m.email)}</span></div><select data-role="${esc(m.id)}" style="width:auto" ${m.id === S.me.user.id ? 'disabled' : ''}><option value="consultant"${m.role === 'consultant' ? ' selected' : ''}>Sales consultant</option><option value="manager"${m.role === 'manager' ? ' selected' : ''}>Manager</option></select>${m.id !== S.me.user.id ? `<button class="ghost" data-act="resetPw" data-id="${esc(m.id)}" data-email="${esc(m.email)}">Password link</button><button class="ghost" data-act="rmUser" data-id="${esc(m.id)}" data-name="${esc(m.name)}">Remove</button>` : ''}</div>`).join('') +
      T.invites.map(i => `<div class="row" style="align-items:center;margin:10px 0"><div style="flex:1">${esc(i.email)}<br><span class="note">Invited as ${i.role === 'manager' ? 'manager' : 'sales consultant'} · pending</span></div><button class="ghost" data-act="rmInvite" data-email="${esc(i.email)}">Cancel</button></div>`).join('') + '</div>' +
      `<div class="card"><b>Invite someone</b><div class="g"><div><label for="iemail">Email</label><input id="iemail" type="email"></div><div><label for="irole">Role</label><select id="irole"><option value="consultant">Sales consultant</option><option value="manager">Manager</option></select></div></div><button class="p" data-act="invite">Create invite link</button>` +
      (S.link ? `<p class="note" style="margin-top:12px">${S.sent ? 'We emailed this link to ' + esc(S.sent) + '. You can also send it yourself:' : 'Send this link to the person (it works once and expires in a few days):'}</p><div class="mono">${esc(S.link)}</div><div class="row"><button class="ghost" data-act="copyLink">Copy link</button></div>` : '') + '</div>';
  }
  $('#teamOut').innerHTML = html;
}
const absLink = l => l.startsWith('http') ? l : location.origin + l;
const invite = guard(async () => { const em = $('#iemail').value.trim(); const j = await api('POST', '/api/invites', { email: em, role: $('#irole').value }); S.link = absLink(j.link); S.sent = j.emailed ? em : ''; await loadTeam(); toast(j.emailed ? 'Invite emailed to ' + em : 'Invite created. Copy the link below and send it.'); });
const resetPw = guard(async d => { const j = await api('POST', `/api/users/${d.id}/reset`, {}); S.link = absLink(j.link); S.sent = j.emailed ? d.email : ''; await loadTeam(); toast(j.emailed ? 'Password link emailed to ' + d.email : 'Link created. Copy it below and send it.'); });
const rmUser = guard(async d => { if (!confirm(`Remove ${d.name}? Their history is deleted and they lose access.`)) return; await api('DELETE', '/api/users/' + d.id); await loadTeam(); });
const rmInvite = guard(async d => { await api('DELETE', '/api/invites', { email: d.email }); await loadTeam(); });
const checkout = guard(async () => { const j = await api('POST', '/api/billing/checkout', { seats: +$('#bseats').value }); location.href = j.url; });
const portal = guard(async () => { const j = await api('POST', '/api/billing/portal', {}); location.href = j.url; });

/* ---------- click routing (no inline handlers: the page runs under a strict CSP) ---------- */
const ACT = {
  tab: d => show(d.v), authView: d => authView(d.v), signout, gen: d => gen(d.force === '1'), cp: d => cp(d.k), share, rate: d => rate(+d.v),
  practiseThis: () => startP(S.obj), practiseL: d => startP(d.k === 'b' ? LIB[+d.i].o : S.team[+d.i].obj), startP: () => startP(), sendP, fbP, saveCfg, savePilot,
  openH, delH, useL, delT, invite, resetPw, rmUser, rmInvite, checkout, portal, copyLink: () => copy(S.link),
};
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && ACT[b.dataset.act]) ACT[b.dataset.act](b.dataset, b); });

/* ---------- start ---------- */
(async () => {
  const p = new URLSearchParams(location.search);
  if (p.get('invite')) {
    S.token = p.get('invite');
    try { const i = await api('GET', '/api/invite/' + encodeURIComponent(S.token)); $('#inviteNote').textContent = `Join ${i.dealership} as ${i.email}.`; showAuth('invite'); }
    catch (e) { showAuth('login'); $('#authErr').textContent = e.message; }
    return;
  }
  if (p.get('reset')) { S.token = p.get('reset'); showAuth('reset'); return; }
  try { enter(await api('GET', '/api/me')); } catch (e) { showAuth('login'); }
})();
