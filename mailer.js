'use strict';
// Sends email through Resend's REST API (https://resend.com). No packages needed.
// Env: RESEND_API_KEY, MAIL_FROM (e.g. "ALERT Coach <hello@yourdomain.com>"), RESEND_API_BASE (tests only).
const enabled = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function send(to, subject, text, html) {
  if (!enabled()) return false;
  try {
    const r = await fetch((process.env.RESEND_API_BASE || 'https://api.resend.com') + '/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text, html }),
    });
    if (!r.ok) console.error('Email failed:', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('Email failed:', e.message); return false; }
}
const wrap = (intro, link, button, note) => ({
  html: `<div style="font-family:Arial,sans-serif;max-width:480px;line-height:1.5;color:#222"><p>${intro}</p><p><a href="${esc(link)}" style="background:#2f6b5a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${button}</a></p><p style="color:#666;font-size:13px">${note}<br>Or paste this into your browser:<br>${esc(link)}</p></div>`,
  text: `${intro.replace(/<[^>]+>/g, '')}\n\n${link}\n\n${note}`,
});
function invite(to, dealership, inviter, link, days) {
  const m = wrap(`${esc(inviter)} has invited you to join <b>${esc(dealership)}</b> on ALERT Objection Coach.`, link, 'Set up your account', `This link works once and expires in ${days} days.`);
  return send(to, `You're invited to ${dealership} on ALERT Objection Coach`, m.text, m.html);
}
function reset(to, name, link) {
  const m = wrap(`Hi ${esc(name)}, your manager sent you a link to set a new password for ALERT Objection Coach.`, link, 'Choose a new password', 'This link works once and expires in 24 hours. If you were not expecting it, you can ignore this email.');
  return send(to, 'Set a new password for ALERT Objection Coach', m.text, m.html);
}
module.exports = { enabled, invite, reset };
