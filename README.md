# Pitch Count Passport

One arm profile per kid. Every coach logs. Nobody overthrows.

A youth pitcher plays for a rec team, a travel team, and maybe catches on the weekend — and each coach only sees their own games. Pitch Count Passport gives each player **one** arm profile that the parent owns. Any linked coach logs pitches with a live tap counter or a quick form, and the app computes total load across every team and tells the next coach — before warm-ups — whether the kid is cleared, on a short leash, or must rest.

Rest rules follow [MLB / USA Baseball Pitch Smart](https://www.mlb.com/pitch-smart/pitching-guidelines): age-based daily max, required rest days by pitch count, never three consecutive days, no catching after 41+ pitches.

**App:** https://keubanks16.github.io/PitchCountPassport/
**API:** https://pitchcountpassport.kollinmeubanks.workers.dev

## How it works

| Role | Can |
|---|---|
| **Parent (owner)** | Create the player, see the passport code, add/remove coaches, log outings, edit or delete anything |
| **Coach** | Link with the parent's 8-character code, log outings for their team, see full cross-team status, edit only their own logs |
| **Viewer** | See status and history only |

The **pre-game card** is a plain-text summary (status, pitches left, last outing, 7-day load) with Copy/Share — text it to the next coach.

## Stack

- `index.html`, `app.js`, `styles.css`, `rules.js` — static PWA on GitHub Pages. No framework, no build step, strict CSP, no `innerHTML` with user data.
- `rules.js` — the Pitch Smart engine. Shared by the app (instant UI) and the Worker (server-side truth).
- `worker/` — Cloudflare Worker + D1 (`pitchcountpassport`).

## Security

- Passwords hashed with PBKDF2-SHA256 (100k iterations, per-user random salt), compared in constant time. Login timing is the same whether or not the email exists.
- Sessions are 256-bit random bearer tokens; only the SHA-256 of the token is stored. 30-day sliding expiry. Changing your password signs out every other device; "Sign out everywhere" is one tap.
- Account lockout after 5 wrong passwords (15 min) + per-IP throttles on signup, login and code linking.
- Every player/outing route re-checks the caller's role on that player. Coaches never see the share code or the access list; non-members get a 404, not a 403, so player IDs leak nothing.
- Share codes can be rotated any time; old codes die immediately. Existing links are unaffected.
- Strict CORS allowlist, `no-store`, `nosniff`, all inputs length- and type-checked, all SQL parameterized, generic 500s.
- Nightly cron purges expired sessions and throttle buckets.

Data stored: name, email, password hash, players' names and birth month/year, pitch logs. Nothing else.

## Deploy

**Frontend** — GitHub Pages from `main`, root folder. Nothing to build.

**Worker** — pushes to `main` that touch `worker/` or `rules.js` deploy automatically via `.github/workflows/deploy-worker.yml`. One-time setup: add a repo secret `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template, plus D1 edit). Or deploy from your machine:

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

The D1 database (`pitchcountpassport`, id in `wrangler.toml`) already exists with the schema applied. To re-apply the schema: `npm run db:schema`.

## Develop / test

```bash
cd worker && npm test          # API + rules tests on an in-memory SQLite shim (no Cloudflare needed)
cd worker && npm run dev       # real Worker locally on :8787
```

To point the web app at a local API, in the browser console: `localStorage.setItem('pcp_api','http://localhost:8787')`.

## Roadmap

- Password reset by email (needs an email provider — Resend or MailChannels binding)
- Read-only public "passport" link for tournament directors
- Import pitch counts from GameChanger / scorebook exports
- Catcher innings and throwing-day tracking for position players
