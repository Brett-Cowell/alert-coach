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

const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function profile(ind, cfg) {
  if (ind !== 'auto') return '';
  const lines = FD.filter(f => cut(cfg[f[0]], 400)).map(f => f[1] + ': ' + cut(cfg[f[0]], 400));
  return lines.length
    ? '\nDealership profile (use these facts where relevant, never invent other facts, and use [brackets] for any fact that is missing):\n' + lines.join('\n')
    : '';
}

function coachPrompt(b, cfg) {
  const ind = IND[b.ind] ? b.ind : 'auto';
  const C = IND[ind], c = b.ctx || {};
  return `You are ${C.coach} using the ALERT framework (Acknowledge, Listen, Explore, Respond, Test). A sales consultant faces this client objection:\n“${cut(b.obj, 600)}”\nProduct/offer: ${cut(c.prod, 120) || 'not given'}\nBuyer: ${cut(c.role, 80) || 'not given'}\nDeal stage: ${cut(c.stage, 60)}\nSo far: ${cut(c.said, 600) || 'nothing'}\nTone: ${cut(c.tone, 30)}.${profile(ind, cfg)}\nReturn ONLY JSON, no markdown: {"acknowledge":"words the sales consultant says aloud, validating without conceding","listen":"an instruction to the sales consultant on what to do and listen for, written as an action (not words to say aloud)","explore":["3 open questions"],"respond":"tailored reply the sales consultant can say, using [brackets] where facts are needed","test":"one closing question that checks if the objection is resolved"}`;
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

async function complete(prompt, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('AI is not configured on this server.'), { status: 503 });
  let res;
  try {
    res = await fetch(API + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw Object.assign(new Error('The AI service did not respond. Please try again.'), { status: 504 });
  }
  if (!res.ok) {
    console.error('Anthropic API error', res.status, (await res.text()).slice(0, 300));
    throw Object.assign(new Error('The AI service returned an error. Please try again.'), { status: 502 });
  }
  const j = await res.json();
  const text = (j.content || []).filter(p => p.type === 'text').map(p => p.text).join('').trim();
  if (!text) throw Object.assign(new Error('The AI service returned an empty answer.'), { status: 502 });
  return text;
}

async function coach(b, cfg) {
  const text = await complete(coachPrompt(b, cfg), 1200);
  let o;
  try { o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
  catch (e) { throw Object.assign(new Error('Could not read the AI answer. Please try again.'), { status: 502 }); }
  const e = Array.isArray(o.explore) ? o.explore.map(x => cut(x, 400)).filter(Boolean).slice(0, 5) : [];
  if (!o.acknowledge || !o.respond || !o.test || !e.length)
    throw Object.assign(new Error('The AI answer was incomplete. Please try again.'), { status: 502 });
  return { a: cut(o.acknowledge, 800), l: cut(o.listen, 800), e, r: cut(o.respond, 1500), t: cut(o.test, 500), src: 'AI' };
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
