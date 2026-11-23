'use strict';
// Stripe subscriptions through Stripe's REST API (no SDK needed).
const crypto = require('node:crypto');
const { q } = require('./db');

const BASE = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');
const APP_URL = () => (process.env.APP_URL || '').replace(/\/$/, '');

const enabled = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

// Stripe expects form-encoded bodies with bracketed keys.
function form(obj) {
  const p = new URLSearchParams();
  (function walk(v, k) {
    if (v && typeof v === 'object') for (const [a, b] of Object.entries(v)) walk(b, k ? `${k}[${a}]` : a);
    else if (v !== undefined && v !== null) p.append(k, String(v));
  })(obj, '');
  return p.toString();
}

async function stripe(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body ? form(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Stripe error', res.status, JSON.stringify(j).slice(0, 300));
    throw Object.assign(new Error('The payment service returned an error.'), { status: 502 });
  }
  return j;
}

async function checkoutUrl(tenant, email, seats) {
  const s = await stripe('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: Math.max(1, seats) }],
    success_url: APP_URL() + '/?billing=success',
    cancel_url: APP_URL() + '/?billing=cancelled',
    client_reference_id: tenant.id,
    ...(tenant.stripe_customer_id ? { customer: tenant.stripe_customer_id } : { customer_email: email }),
    allow_promotion_codes: 'true',
    metadata: { tenant_id: tenant.id },
    subscription_data: { metadata: { tenant_id: tenant.id } },
  });
  return s.url;
}

async function portalUrl(tenant) {
  const s = await stripe('POST', '/v1/billing_portal/sessions', {
    customer: tenant.stripe_customer_id,
    return_url: APP_URL() + '/',
  });
  return s.url;
}

// Verifies the Stripe-Signature header: HMAC-SHA256 of "<timestamp>.<raw body>".
function verify(raw, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(x => x.split('=')).filter(x => x.length === 2));
  const t = parts.t, sigs = header.split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const exp = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some(s => s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp)));
}

function applySubscription(sub, tenantId) {
  const t = tenantId
    ? q.one('SELECT id FROM tenants WHERE id=?', tenantId)
    : q.one('SELECT id FROM tenants WHERE stripe_customer_id=?', sub.customer);
  if (!t) return false;
  const qty = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].quantity;
  q.run('UPDATE tenants SET stripe_customer_id=?, stripe_sub_id=?, sub_status=?, seats=COALESCE(?,seats) WHERE id=?',
    sub.customer, sub.id, sub.status, qty || null, t.id);
  return true;
}

async function handleEvent(ev) {
  const o = ev.data && ev.data.object;
  if (!o) return;
  if (ev.type === 'checkout.session.completed' && o.mode === 'subscription' && o.subscription) {
    const tid = o.client_reference_id || (o.metadata && o.metadata.tenant_id);
    q.run('UPDATE tenants SET stripe_customer_id=? WHERE id=?', o.customer, tid);
    const sub = await stripe('GET', '/v1/subscriptions/' + encodeURIComponent(o.subscription));
    applySubscription(sub, tid);
  } else if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) {
    applySubscription(o, o.metadata && o.metadata.tenant_id);
  }
}

module.exports = { enabled, checkoutUrl, portalUrl, verify, handleEvent };
