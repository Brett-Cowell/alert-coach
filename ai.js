'use strict';
// Builds the prompts and calls the Anthropic Messages API. The browser never sees the API key
// and cannot send its own prompt: it only sends the objection and a few fields.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// public/data.js is shared with the browser, so the industries are defined once.
const D = vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, 'public', 'data.js'), 'utf8') + ';({IND,FD})',
  {}, { timeout: 2000 });
const IND = D.IND, FD = D.FD;

const API = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const COUNTRY = { 'Australia': 'AU', 'New Zealand': 'NZ', 'United Kingdom': 'GB', 'Ireland': 'IE', 'United States': 'US', 'Canada': 'CA', 'South Africa': 'ZA', 'United Arab Emirates': 'AE', 'Singapore': 'SG', 'Malaysia': 'MY', 'Philippines': 'PH', 'India': 'IN' };
const SEARCH_ON = () => (process.env.WEB_SEARCH || 'on').toLowerCase() !== 'off';
const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function profile(ind, cfg) {
  if (ind !== 'auto') return '';
  const lines = FD.filter(f => cut(cfg[f[0]], 400)).map(f => f[1] + ': ' + cut(cfg[f[0]], 400));
  return lines.length
    ? '\nDealership profile (use these facts where relevant, never invent other facts, and use [brackets] for any fact that is missing):\n' + lines.join('\n')
    : '';
}

function coachPrompt(b, cfg, research) {
  const ind = IND[b.ind] ? b.ind : 'auto';
  const C = IND[ind], c = b.ctx || {}, comp = cut(c.comp, 300), mkt = ind === 'auto' ? cut(cfg.market, 60) : '';
  const local = mkt && mkt !== 'Other' ? `\nWrite for the ${mkt}${cut(cfg.region, 80) ? ' (' + cut(cfg.region, 80) + ')' : ''} market: use local spelling, local currency and local car-buying terms, and only refer to consumer rules or incentives that apply there.` : '';
  const rival = comp ? `\nCompetitors the client is also considering: ${comp}.\n` + (research
    ? 'Use web search (at most a few searches) to find current, factual details about those competitors in this market: relevant specs, pricing or price positioning, and any publicly advertised offers or incentives. '
    : 'Live market research is not available, so use only well-established facts and put [brackets] where a current fact would be needed. ') +
    'Be accurate and fair: never invent figures or offers, never disparage a competitor, and if you could not find reliable information say so. Work the useful facts into the "respond" and "explore" lines the sales consultant can say.' : '';
  const intel = comp ? ', "market":{"competitors":[{"name":"competitor","points":["short factual point, with the source year or date if known"]}],"offers":["each competitor or market offer found: who, what, until when"],"caveat":"one sentence on what could not be confirmed"}' : '';
  return `You are ${C.coach} using the ALERT framework (Acknowledge, Listen, Explore, Respond, Test). A sales consultant faces this client objection:\n“${cut(b.obj, 600)}”\nProduct/offer: ${cut(c.prod, 120) || 'not given'}\nBuyer: ${cut(c.role, 80) || 'not given'}\nDeal stage: ${cut(c.stage, 60)}\nSo far: ${cut(c.said, 600) || 'nothing'}\nTone: ${cut(c.tone, 30)}.${profile(ind, cfg)}${local}${rival}\nReturn ONLY JSON, no markdown: {"acknowledge":"words the sales consultant says aloud, validating without conceding","listen":"an instruction to the sales consultant on what to do and listen for, written as an action (not words to say aloud)","explore":["3 open questions"],"respond":"tailored reply the sales consultant can say, using [brackets] where facts are needed","test":"one closing question that checks if the objection is resolved"${intel}}`;
}

function transcript(chat) {
  return (Array.isArray(chat) ? chat : []).slice(-20)
    .map(m => (m && m.w === 'c' ? 'Client: ' : 'Sales consultant: ') + cut(m && m.t, 1000)).join('\n');
}

function practicePrompt(b) {
  const ind = IND[b.ind] ? b.ind : 'auto';
  return `Role-play as a sales prospect (${IND[ind].who}): ${cut(b.persona, 100)}. Your original objection: “${cut(b.objection, 300)}”. Stay in character, be realistic: soften only if the sales consultant earns it with good acknowledgement, questions and relevance; otherwise push back or deflect. Reply with ONLY the client’s next 1–3 sentences.\n\n${transcript(b.chat)}\nClient:`;
}

function feedbackPrompt(b) {
  return `You are a sales coach. Review this role-play against ALERT (Acknowledge, Listen, Explore, Respond, Test). For each step give a score out of 5 and one specific sentence. Then give the single most useful improvement and a rewritten version of the sales consultant’s weakest line. Be concise, plain text. Finish with one last line exactly like: SCORES: A=3,L=4,E=2,R=3,T=1\n\n${transcript(b.chat)}`;
}

async function complete(prompt, maxTokens, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('AI is not configured on this server.'), { status: 503 });
  const call = async body => {
    try {
      return await fetch(API + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.tools ? 110000 : 60000),
      });
    } catch (e) { throw Object.assign(new Error('The AI service did not respond. Please try again.'), { status: 504 }); }
  };
  let messages = [{ role: 'user', content: prompt }], tools = opts.tools, researched = !!tools, content = [], sources = [];
  for (let turn = 0; turn < 4; turn++) {
    const body = { model: MODEL, max_tokens: maxTokens, messages };
    if (tools) body.tools = tools;
    let res = await call(body);
    if (!res.ok && tools) { // search unavailable (for example not enabled on the Anthropic account): carry on without it
      console.error('Anthropic web search error', res.status, (await res.text()).slice(0, 300));
      tools = null; researched = false; content = []; sources = [];
      messages = [{ role: 'user', content: opts.fallbackPrompt || prompt }];
      res = await call({ model: MODEL, max_tokens: maxTokens, messages });
    }
    if (!res.ok) {
      console.error('Anthropic API error', res.status, (await res.text()).slice(0, 300));
      throw Object.assign(new Error('The AI service returned an error. Please try again.'), { status: 502 });
    }
    const j = await res.json();
    content = content.concat(j.content || []);
    if (j.stop_reason === 'pause_turn' && tools) { messages = [{ role: 'user', content: prompt }, { role: 'assistant', content }]; continue; }
    break;
  }
  const lastTool = content.reduce((n, p, i) => (p.type === 'web_search_tool_result' || p.type === 'server_tool_use' ? i : n), -1);
  const text = content.filter((p, i) => p.type === 'text' && i > lastTool).map(p => p.text).join('').trim();
  for (const p of content) if (p.type === 'web_search_tool_result' && Array.isArray(p.content))
    for (const r of p.content) if (r && /^https:\/\//.test(r.url || '') && !sources.some(x => x.url === r.url)) sources.push({ title: cut(r.title, 120) || r.url, url: String(r.url).slice(0, 400) });
  if (!text) throw Object.assign(new Error('The AI service returned an empty answer.'), { status: 502 });
  return opts.detail ? { text, sources: sources.slice(0, 6), researched } : text;
}

async function coach(b, cfg) {
  const comp = cut((b.ctx || {}).comp, 300), research = !!comp && (b.ctx || {}).research !== false && SEARCH_ON();
  const mkt = IND[b.ind] && b.ind !== 'auto' ? '' : cut(cfg.market, 60);
  const tools = research ? [Object.assign({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }, COUNTRY[mkt] ? { user_location: { type: 'approximate', country: COUNTRY[mkt] } } : {})] : null;
  const out = await complete(coachPrompt(b, cfg, research), comp ? 2200 : 1200, { tools, detail: true, fallbackPrompt: research ? coachPrompt(b, cfg, false) : null });
  const text = out.text;
  let o;
  try { o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
  catch (e) { throw Object.assign(new Error('Could not read the AI answer. Please try again.'), { status: 502 }); }
  const e = Array.isArray(o.explore) ? o.explore.map(x => cut(x, 400)).filter(Boolean).slice(0, 5) : [];
  if (!o.acknowledge || !o.respond || !o.test || !e.length)
    throw Object.assign(new Error('The AI answer was incomplete. Please try again.'), { status: 502 });
  const r = { a: cut(o.acknowledge, 800), l: cut(o.listen, 800), e, r: cut(o.respond, 1500), t: cut(o.test, 500), src: 'AI' };
  if (comp && o.market && typeof o.market === 'object') {
    const arr = (v, n, m) => (Array.isArray(v) ? v : []).map(x => cut(x, n)).filter(Boolean).slice(0, m);
    const cs = (Array.isArray(o.market.competitors) ? o.market.competitors : []).slice(0, 4).map(x => ({ name: cut(x && x.name, 80), points: arr(x && x.points, 300, 6) })).filter(x => x.name && x.points.length);
    r.m = { competitors: cs, offers: arr(o.market.offers, 300, 6), caveat: cut(o.market.caveat, 300), researched: out.researched, sources: out.researched ? out.sources : [], asked: comp };
  }
  return r;
}

async function practice(b) {
  const t = await complete(practicePrompt(b), 300);
  return { text: t.replace(/^Client:\s*/i, '').trim() };
}

async function feedback(b) {
  const t = await complete(feedbackPrompt(b), 900);
  const m = t.match(/SCORES:\s*A=(\d)\D+L=(\d)\D+E=(\d)\D+R=(\d)\D+T=(\d)/i);
  return {
    text: t.replace(/\n?SCORES:.*$/im, '').trim(),
    scores: m ? m.slice(1, 6).map(n => Math.min(5, +n)) : null,
  };
}

module.exports = { coach, practice, feedback, IND, FD };
