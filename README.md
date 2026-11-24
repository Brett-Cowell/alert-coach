# ALERT Objection Coach: standalone app

A small web app for dealerships. Sales consultants enter a customer objection and get a response in the ALERT structure (Acknowledge, Listen, Explore, Respond, Test). Managers get dealership setup, team insights, a pilot checklist, and team and billing management. Each dealership's data is kept separate.

No packages to install. It needs **Node 22.13 or newer**, which includes the built-in SQLite.

## 1. Run it on your computer

```
cp .env.example .env      # then fill in ANTHROPIC_API_KEY at minimum
export $(grep -v '^#' .env | xargs)
npm start                 # http://localhost:3000
```

Create an account on the sign-up screen. That person becomes the dealership manager. Without `STRIPE_*` set, billing shows "not set up" and the 30-day trial applies.

Run the backend tests (they use fake AI and Stripe services, no keys needed): `npm test`

## 2. Put it on the internet

Any host that runs a Node or Docker app **with a persistent disk** works (Fly.io, Render, Railway, a small VPS). The database is one SQLite file, so the disk matters: without it, data is lost on every deploy.

Example with Docker:
```
docker build -t alert-coach .
docker run -d -p 3000:3000 -v alert-data:/data --env-file .env alert-coach
```
Put it behind HTTPS (your host usually does this; on a VPS use Caddy or nginx). Set `APP_URL` to the final https address and `NODE_ENV=production`. Run **one instance only**; SQLite is not for multiple servers.

**Backups:** copy `/data/app.db` (and the `-wal` file beside it) daily, or use your host's volume snapshots.

## 3. Turn on AI

Create a key at console.anthropic.com and set `ANTHROPIC_API_KEY`. Each trial or subscribed dealership user has a daily limit (`AI_DAILY_LIMIT`, default 150) so costs stay predictable. Set a monthly spend limit in the Anthropic console too.

## 4. Turn on billing (Stripe)

1. In Stripe, create a Product with a **recurring monthly Price, per unit** (this is per seat). Put its id in `STRIPE_PRICE_ID`.
2. Put your secret key in `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint: `https://YOUR-APP-URL/api/stripe/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Enable the Customer Portal in Stripe settings so managers can change card or cancel.
5. Test the whole flow in Stripe **test mode** first (card 4242 4242 4242 4242).

## 5. Turn on email (optional but recommended)

Without this, managers copy invite and password links and send them by hand. With it, the app emails them automatically (the link is still shown as a backup).

1. Create an account at resend.com and add your domain under **Domains**. Add the DNS records Resend shows you at wherever you bought the domain, then wait for it to say Verified.
2. Create an API key and set `RESEND_API_KEY`.
3. Set `MAIL_FROM` to an address on that domain, like `ALERT Coach <hello@yourdomain.com>`.

Resend only lets you email other people from a verified domain. Until then it will only deliver to your own address.

## 6. Day-to-day owner tools

```
npm run admin -- list                    # dealerships, seats, trial or subscription
npm run admin -- extend <tenantId> 14    # give a dealership 14 more trial days
npm run admin -- seats <tenantId> 10     # change seat limit by hand
```

## Go-live checklist

- [ ] Open the live site over https and complete a sign-up, invite, and sign-in as a second user
- [ ] Confirm a sales consultant cannot see the Team insights, Pilot, or Team & billing tabs
- [ ] Complete one test-mode Stripe subscription and check the trial banner disappears
- [ ] Confirm backups restore (copy the database to a test location and open it)
- [ ] Add a privacy policy and terms of use page, and tell customers that objection text is sent to Anthropic to generate responses. Ask a lawyer to check these for your country.
- [ ] Tell dealerships not to type customers' names or personal details into the objection box
- [ ] Set a monthly spend limit in the Anthropic console

## Known limits

- Invite and password emails need the optional email setup in section 5; without it the manager copies the links by hand.
- The login rate limit is in memory, so it resets when the server restarts.
- Only the automotive library is fully built out; other industries use a short generic library.
- The browser front end has had a syntax check and a cross-check of its element ids against the page, but has not been clicked through in a real browser. Do that on the live site before showing a customer.

## Layout

`server.js` API and static files · `db.js` SQLite · `ai.js` prompts and AI calls · `billing.js` Stripe · `public/` the pages · `test/e2e.js` tests · `scripts/admin.js` owner tools
