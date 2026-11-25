'use strict';
// End-to-end test: runs the real server against fake Anthropic and Stripe services.
// Usage: node test/e2e.js   (needs Node 22.13+, no installs)
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const mock = { prompts: [], bodies: [], stripe: [] };
const fakeAI = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const body = JSON.parse(b), prompt = body.messages[0].content; mock.prompts.push(prompt); mock.bodies.push(body);
    let text = 'Client: Honestly I need to stay near $350 a month.';
    if (prompt.includes('Return ONLY JSON')) text = JSON.stringify({ acknowledge: '“I hear you.”', listen: 'Stay quiet and let them finish.', explore: ['What number works?', 'What is included?', 'What matters most?'], respond: 'Here is how we compare.', test: 'Does that help?' });
    if (prompt.startsWith('You are a sales coach')) text = 'ACKNOWLEDGE: 3/5. Fine.\nSCORES: A=3,L=4,E=2,R=3,T=1';
    res.setHeader('content-type', 'application/json');
    if (prompt.includes('MESSY')) text = 'Sure! Here is the answer:\n```json\n{"acknowledge":"I hear you.","listen":"Stay quiet.","explore":["a?","b?","c?",],"respond":"Line one\nLine two {braces}","test":"Does that help?",}\n```\nHope {that} helps';
    if (prompt.includes('BADONCE') && !mock.badonce) { mock.badonce = 1; text = 'I could not do that.'; }
    if (prompt.includes('ALWAYSBAD')) text = '{"acknowledge":"cut off';
    if (body.tools && prompt.includes('FAILTOOL')) { res.statusCode = 400; return res.end('{"error":"web search not enabled"}'); }
    if (body.tools) {
      const j = { competitors: 0 };
      const out = JSON.parse(text); out.market = { competitors: [{ name: 'Hyundai Tucson', points: ['Starts around $38,000 drive-away (2026)', 'Advertised 7-year warranty'] }], offers: ['Smith Hyundai: $2,000 trade-in bonus until 30 Nov'], caveat: 'Stock levels not confirmed.' };
      return res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Let me search.' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'Hyundai Tucson pricing', url: 'https://example.com/tucson' }, { type: 'web_search_result', title: 'Bad link', url: 'javascript:alert(1)' }] }, { type: 'text', text: JSON.stringify(out) }] }));
    }
    if (prompt.includes('Return ONLY JSON') && prompt.includes('Competitors the client')) { const out = JSON.parse(text); out.market = { competitors: [{ name: 'Rival', points: ['General fact'] }], offers: [], caveat: 'No live data.' }; text = JSON.stringify(out); }
    res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
  });
});
const fakeStripe = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    mock.stripe.push({ method: req.method, url: req.url, body: b, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ url: 'https://stripe.test/checkout/abc' }));
    if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ url: 'https://stripe.test/portal/abc' }));
    if (req.url.startsWith('/v1/subscriptions/')) return res.end(JSON.stringify({ id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ quantity: 7 }] } }));
    res.statusCode = 404; res.end('{}');
  });
});
const mails = [];
const fakeMail = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => { mails.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end('{"id":"m1"}'); });
});
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
  const [aiPort, stPort, mailPort] = [await listen(fakeAI), await listen(fakeStripe), await listen(fakeMail)];
  Object.assign(process.env, {
    DATABASE_FILE: ':memory:', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${aiPort}`,
    STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_123', STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_API_BASE: `http://127.0.0.1:${stPort}`, APP_URL: 'https://coach.example.com', TRIAL_SEATS: '3',
    RESEND_API_KEY: 're_test', MAIL_FROM: 'Coach <hi@coach.example.com>', RESEND_API_BASE: `http://127.0.0.1:${mailPort}`,
  });
  const { server } = require('../server');
  const { q } = require('../db');
  const port = await listen(server), base = `http://127.0.0.1:${port}`;

  const client = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await r.text(); let j; try { j = JSON.parse(text); } catch (e) { j = text; }
      return { s: r.status, j, h: r.headers };
    };
  };
  let passed = 0;
  const ok = (name, fn) => fn().then(() => { passed++; console.log('  ok  ' + name); }, e => { console.error('FAIL  ' + name + '\n', e); process.exitCode = 1; });

  const A = client(), M = client(), C = client(), X = client();
  let inviteLink;

  await ok('static page and path traversal', async () => {
    assert.equal((await A('GET', '/')).s, 200);
    assert.equal((await A('GET', '/data.js')).s, 200);
    assert.equal((await A('GET', '/..%2fserver.js')).s, 404);
    assert.equal((await A('GET', '/api/me')).s, 401);
  });
  await ok('signup validates and creates a trial', async () => {
    assert.equal((await A('POST', '/api/signup', { dealership: 'Metro Auto', name: 'Mia', email: 'bad', password: 'longenoughpw' })).s, 400);
    assert.equal((await A('POST', '/api/signup', { dealership: 'Metro Auto', name: 'Mia', email: 'mia@metro.test', password: 'short' })).s, 400);
    const r = await M('POST', '/api/signup', { dealership: 'Metro Auto', name: 'Mia', email: 'mia@metro.test', password: 'a-long-password' });
    assert.equal(r.s, 201); assert.equal(r.j.user.role, 'manager'); assert.equal(r.j.plan.status, 'trial'); assert.equal(r.j.plan.seats, 3);
    assert.match(r.h.get('set-cookie'), /HttpOnly/);
    assert.equal((await A('POST', '/api/signup', { dealership: 'X', name: 'Y', email: 'MIA@metro.test', password: 'a-long-password' })).s, 409);
  });
  await ok('login works, wrong password refused', async () => {
    assert.equal((await A('POST', '/api/login', { email: 'mia@metro.test', password: 'wrong-password' })).s, 401);
    const r = await A('POST', '/api/login', { email: 'mia@metro.test', password: 'a-long-password' });
    assert.equal(r.s, 200); assert.equal((await A('GET', '/api/me')).j.user.email, 'mia@metro.test');
  });
  await ok('mutating requests must be JSON', async () => {
    assert.equal((await M('POST', '/api/history', 'obj=x', { 'content-type': 'text/plain' })).s, 415);
  });
  await ok('manager saves dealership details; AI uses them', async () => {
    assert.equal((await M('PUT', '/api/config', { dealer: 'Metro Auto Group', warranty: 'a 5-year warranty', ignored: 'x' })).s, 200);
    assert.equal((await M('GET', '/api/me')).j.config.warranty, 'a 5-year warranty');
    const r = await M('POST', '/api/ai', { task: 'coach', obj: 'Another dealer quoted me less', ind: 'auto', ctx: { stage: 'Quote', tone: 'Warm' } });
    assert.equal(r.s, 200); assert.equal(r.j.result.e.length, 3); assert.equal(r.j.result.src, 'AI');
    const p = mock.prompts.at(-1);
    assert.match(p, /a 5-year warranty/); assert.match(p, /Another dealer quoted me less/); assert.match(p, /sales consultant/);
  });
  await ok('market setting and competitor research', async () => {
    assert.equal((await M('PUT', '/api/config', { dealer: 'Metro Auto Group', market: 'Australia', region: 'Sydney, NSW', warranty: 'a 5-year warranty' })).s, 200);
    assert.equal((await M('GET', '/api/me')).j.config.market, 'Australia');
    let r = await M('POST', '/api/ai', { task: 'coach', obj: 'Another dealer quoted me less', ind: 'auto', ctx: { comp: 'Hyundai Tucson at Smith Hyundai', research: true } });
    assert.equal(r.s, 200);
    let b = mock.bodies.at(-1);
    assert.equal(b.tools[0].name, 'web_search'); assert.equal(b.tools[0].user_location.country, 'AU'); assert.ok(b.tools[0].max_uses <= 3);
    assert.match(mock.prompts.at(-1), /Australia/); assert.match(mock.prompts.at(-1), /Sydney, NSW/); assert.match(mock.prompts.at(-1), /Hyundai Tucson at Smith Hyundai/);
    const m = r.j.result.m;
    assert.equal(m.researched, true); assert.equal(m.competitors[0].name, 'Hyundai Tucson'); assert.match(m.offers[0], /trade-in bonus/);
    assert.deepEqual(m.sources, [{ title: 'Hyundai Tucson pricing', url: 'https://example.com/tucson' }]); // javascript: link dropped
    assert.equal(r.j.result.e.length, 3);
    // research switched off: no search tool, still returns competitor notes
    r = await M('POST', '/api/ai', { task: 'coach', obj: 'Price is high', ind: 'auto', ctx: { comp: 'Mazda CX-5', research: false } });
    assert.equal(mock.bodies.at(-1).tools, undefined); assert.equal(r.j.result.m.researched, false); assert.deepEqual(r.j.result.m.sources, []);
    // search unavailable on the Anthropic account: falls back and says so
    r = await M('POST', '/api/ai', { task: 'coach', obj: 'Price is high', ind: 'auto', ctx: { comp: 'FAILTOOL rival', research: true } });
    assert.equal(r.s, 200); assert.equal(r.j.result.m.researched, false); assert.ok(!/Use web search/.test(mock.prompts.at(-1)));
    // no competitors: no search, no market block
    r = await M('POST', '/api/ai', { task: 'coach', obj: 'Price is high', ind: 'auto', ctx: {} });
    assert.equal(mock.bodies.at(-1).tools, undefined); assert.equal(r.j.result.m, undefined);
  });
  await ok('messy or unreadable AI answers are handled', async () => {
    const go = obj => M('POST', '/api/ai', { task: 'coach', obj, ind: 'auto', ctx: {} });
    let r = await go('MESSY objection');
    assert.equal(r.s, 200); assert.equal(r.j.result.r, "Line one Line two {braces}"); assert.equal(r.j.result.e.length, 3);
    const before = mock.prompts.length;
    r = await go('BADONCE objection');
    assert.equal(r.s, 200); assert.equal(mock.prompts.length - before, 2); // retried once and recovered
    r = await go('ALWAYSBAD objection');
    assert.equal(r.s, 502); assert.match(r.j.error, /Could not read/);
  });
  await ok('practice and feedback', async () => {
    const chat = [{ w: 'c', t: 'Payment too high' }, { w: 'r', t: 'What number works?' }];
    const p = await M('POST', '/api/ai', { task: 'practice', ind: 'auto', objection: 'Payment too high', persona: 'Price-focused buyer', chat });
    assert.match(p.j.text, /350/); assert.ok(!/^Client:/.test(p.j.text));
    const f = await M('POST', '/api/ai', { task: 'feedback', ind: 'auto', chat });
    assert.deepEqual(f.j.scores, [3, 4, 2, 3, 1]); assert.ok(!/SCORES/.test(f.j.text));
    assert.equal((await M('POST', '/api/ai', { task: 'nope' })).s, 400);
  });
  await ok('invite, seat limit, accept', async () => {
    const r = await M('POST', '/api/invites', { email: 'sam@metro.test', role: 'consultant' });
    assert.equal(r.s, 201); assert.equal(r.j.emailed, true);
    assert.deepEqual(mails[0].to, ['sam@metro.test']); assert.equal(mails[0].auth, 'Bearer re_test'); assert.ok(mails[0].html.includes(r.j.link) && mails[0].text.includes(r.j.link));
    inviteLink = r.j.link; assert.match(inviteLink, /^https:\/\/coach\.example\.com\/\?invite=/);
    const token = inviteLink.split('invite=')[1];
    assert.equal((await A('GET', '/api/invite/' + token)).j.email, 'sam@metro.test');
    assert.equal((await M('POST', '/api/invites', { email: 'lee@metro.test' })).s, 201);
    assert.equal((await M('POST', '/api/invites', { email: 'third@metro.test' })).s, 402); // 1 member + 2 pending = 3 seats
    const a = await C('POST', '/api/accept-invite', { token, name: 'Sam', password: 'another-long-pw' });
    assert.equal(a.s, 201); assert.equal(a.j.user.role, 'consultant');
    assert.equal((await A('GET', '/api/invite/' + token)).s, 400); // single use
  });
  await ok('consultant cannot manage', async () => {
    for (const [m, p, b] of [['PUT', '/api/config', { dealer: 'x' }], ['GET', '/api/usage'], ['GET', '/api/team'], ['POST', '/api/invites', { email: 'z@z.test' }], ['POST', '/api/billing/checkout', {}], ['PUT', '/api/pilot', {}]])
      assert.equal((await C(m, p, b)).s, 403, m + ' ' + p);
    assert.equal((await C('GET', '/api/me')).j.config.dealer, 'Metro Auto Group'); // can read details
  });
  await ok('history is private, library is shared inside one dealership', async () => {
    await C('POST', '/api/history', { obj: 'Sam objection', r: { a: 'x' }, c: {} });
    assert.equal((await C('GET', '/api/history')).j.length, 1);
    assert.equal((await M('GET', '/api/history')).j.length, 0);
    const lib = await C('POST', '/api/library', { obj: 'Shared objection', ind: 'auto', r: { a: 'Ack', e: ['q'], r: 'r', t: 't', l: 'l' } });
    assert.equal(lib.s, 201);
    assert.equal((await M('GET', '/api/library')).j[0].obj, 'Shared objection');
    // a different dealership sees nothing
    assert.equal((await X('POST', '/api/signup', { dealership: 'Other Motors', name: 'Oz', email: 'oz@other.test', password: 'a-long-password' })).s, 201);
    assert.equal((await X('GET', '/api/library')).j.length, 0);
    assert.equal((await X('DELETE', '/api/library/' + lib.j.id)).s, 200);
    assert.equal((await M('GET', '/api/library')).j.length, 1); // other tenant could not delete it
    assert.equal((await M('DELETE', '/api/library/' + lib.j.id)).s, 200); // manager can
  });
  await ok('usage events and manager insights', async () => {
    await C('POST', '/api/usage', { type: 'coach', key: 'price', cat: 'Retail', src: 'Library', ind: 'auto' });
    await C('POST', '/api/usage', { type: 'practice', key: 'price', scores: [3, 4, 2, 3, 1], ind: 'auto' });
    await C('POST', '/api/usage', { type: 'rating', key: 'price', up: 1, ind: 'auto' });
    assert.equal((await C('POST', '/api/usage', { type: 'hack' })).s, 400);
    const u = (await M('GET', '/api/usage')).j;
    assert.equal(u.length, 3); assert.equal(u[0].name, 'Sam');
    assert.equal((await X('GET', '/api/usage')).j.length, 0);
  });
  await ok('team management', async () => {
    const t = (await M('GET', '/api/team')).j;
    assert.equal(t.members.length, 2); assert.equal(t.invites.length, 1);
    const sam = t.members.find(m => m.email === 'sam@metro.test');
    const reset = await M('POST', `/api/users/${sam.id}/reset`);
    assert.equal(reset.s, 201); assert.equal(reset.j.emailed, true); assert.deepEqual(mails[mails.length - 1].to, ['sam@metro.test']);
    assert.equal((await A('POST', '/api/reset', { token: reset.j.link.split('reset=')[1], password: 'brand-new-password' })).s, 200);
    assert.equal((await C('GET', '/api/me')).s, 401); // old sessions ended
    assert.equal((await C('POST', '/api/login', { email: 'sam@metro.test', password: 'brand-new-password' })).s, 200);
    assert.equal((await M('PATCH', `/api/users/${sam.id}`, { role: 'manager' })).s, 200);
    assert.equal((await M('DELETE', `/api/users/${t.members[0].id}`)).s, 400); // not yourself
    assert.equal((await M('DELETE', '/api/invites', { email: 'lee@metro.test' })).s, 200);
  });
  await ok('billing: checkout, webhook signature, seats, portal', async () => {
    const tid = (await M('GET', '/api/me')).j.tenant.id;
    const c = await M('POST', '/api/billing/checkout', { seats: 7 });
    assert.equal(c.s, 200); assert.equal(c.j.url, 'https://stripe.test/checkout/abc');
    const sent = new URLSearchParams(mock.stripe.at(-1).body);
    assert.equal(sent.get('line_items[0][price]'), 'price_123'); assert.equal(sent.get('line_items[0][quantity]'), '7');
    assert.equal(sent.get('client_reference_id'), tid); assert.equal(mock.stripe.at(-1).auth, 'Bearer sk_test_x');
    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: tid } } });
    const sign = (body, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
    assert.equal((await A('POST', '/api/stripe/webhook', event, { 'content-type': 'application/json', 'stripe-signature': sign(event, 'wrong') })).s, 400);
    assert.equal((await A('POST', '/api/stripe/webhook', event, { 'content-type': 'application/json', 'stripe-signature': sign(event, 'whsec_test', 1000) })).s, 400); // stale
    assert.equal((await A('POST', '/api/stripe/webhook', event, { 'content-type': 'application/json', 'stripe-signature': sign(event, 'whsec_test') })).s, 200);
    const me = (await M('GET', '/api/me')).j.plan;
    assert.equal(me.status, 'subscribed'); assert.equal(me.seats, 7); assert.equal(me.hasCustomer, true);
    assert.equal((await M('POST', '/api/billing/checkout', {})).s, 400); // already subscribed
    assert.equal((await M('POST', '/api/billing/portal', {})).j.url, 'https://stripe.test/portal/abc');
    const upd = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', items: { data: [{ quantity: 7 }] }, metadata: { tenant_id: tid } } } });
    assert.equal((await A('POST', '/api/stripe/webhook', upd, { 'content-type': 'application/json', 'stripe-signature': sign(upd, 'whsec_test') })).s, 200);
    assert.equal((await M('GET', '/api/me')).j.plan.status, 'trial'); // trial still running
  });
  await ok('expired trial blocks AI but not the rest', async () => {
    q.run('UPDATE tenants SET trial_ends_at=?', Date.now() - 1000);
    assert.equal((await M('GET', '/api/me')).j.plan.status, 'expired');
    assert.equal((await M('POST', '/api/ai', { task: 'coach', obj: 'x' })).s, 402);
    assert.equal((await M('GET', '/api/library')).s, 200);
  });
  await ok('daily AI limit', async () => {
    q.run('UPDATE tenants SET trial_ends_at=?', Date.now() + 1e9);
    const day = new Date().toISOString().slice(0, 10), me = (await M('GET', '/api/me')).j.user.id;
    q.run('INSERT INTO ai_calls(user_id,day,n) VALUES(?,?,150) ON CONFLICT(user_id,day) DO UPDATE SET n=150', me, day);
    assert.equal((await M('POST', '/api/ai', { task: 'coach', obj: 'x' })).s, 429);
  });
  await ok('login throttling', async () => {
    let last; for (let i = 0; i < 12; i++) last = await A('POST', '/api/login', { email: 'nobody@x.test', password: 'whatever-whatever' });
    assert.equal(last.s, 429);
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ', with failures' : ''}`);
  server.close(); fakeAI.close(); fakeStripe.close(); fakeMail.close();
})();
