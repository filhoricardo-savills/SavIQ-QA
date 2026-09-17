# CLAUDE.md — SavIQ Meter QA Review

Read this before touching anything. It is the memory of how this project was built and why. The README explains the app to a person; this file explains it to you.

## What this is

A weekly data-quality issue tracker for SavIQ metering data across 21 Savills-managed accounts, built for a recurring QA call. Five users at Savills Ireland. Live at https://sav-iq-qa.vercel.app. Built September 2026 with Ricardo Filho, who owns it and is the administrator.

The workflow it serves: issues get raised during the week; at the call, each open item is marked Closed / Still open / Deferred; anything not closed is counted as carried, with the week count visible. The **Meter analysis** tab runs the SavIQ checks against a DEXMA account and lets a person curate findings into issues.

## Architecture in one paragraph

A single static page (`index.html`) talking straight to Supabase. No framework, no build step, no bundler. `config.js` holds the Supabase project URL and the **publishable** key — both are meant to be public. `analysis.js` is the meter-analysis port. `api/dexma.js` is the only server-side code: a Vercel serverless relay to the DEXMA API, needed because DEXMA sends no CORS headers. Vercel deploys on every push to `main`. Supabase (EU region) holds data, auth and realtime. Row-level security in `supabase/schema.sql` restricts everything to `@savills.ie` addresses — that is the security boundary, not the page.

The interactive maps in `docs/` explain this visually; `docs/architecture.html` is the one to open first.

## How to work on it

- **Edit `index.html` directly.** It is one file, assembled by hand. There is no build. Vercel serves what is committed.
- **Push to deploy.** `git push origin main` is the deployment. About a minute.
- **Syntax-check before committing.** Extract the script and run `node --check` on it; the file is large and a stray quote is easy to miss:
  ```
  python -c "s=open('index.html',encoding='utf-8').read();b=s.split('<script>\n\"use strict\";',1)[1].rsplit('</script>',1)[0];open('/tmp/chk.js','w',encoding='utf-8').write('\"use strict\";'+b)" && node --check /tmp/chk.js
  ```
  Also `node --check analysis.js` and `node --check api/dexma.js` if touched.
- **Database changes are numbered migrations** in `supabase/`. `schema.sql` is the full original; `002-device-name.sql` was the first increment. Ricardo runs them in the Supabase SQL Editor. Always `if not exists` / `create or replace` so they are safe to re-run.
- **Commit messages end with** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Do not add a framework, a bundler, or a `package.json`** at the root. The zero-config deploy depends on it. `api/dexma.js` is CommonJS for the same reason.

## Things that cost real time to learn — do not relearn them

**Savills email security pre-clicks links.** Defender fetches every URL in a message. A single-use sign-in link is consumed before the recipient clicks it. This is why sign-in is **email + password**, not magic link. The one confirmation link at sign-up is safe: being clicked is its whole job. Never switch back to link-based sign-in on a Savills mailbox.

**Supabase free tier cannot edit email templates without custom SMTP.** So the 6-digit-code approach was not available either. SMTP is still not configured; a forgotten password currently needs an admin to run SQL against `auth.users`. Configuring SMTP (Brevo, or a Savills relay) fixes this properly.

**DEXMA's API has no CORS headers.** The browser cannot call it. Everything goes through `/api/dexma`, which requires a valid QA session (verified against Supabase) and the caller's own DEXMA token. The token is used for one upstream call and never stored or logged. Only `/devices`, `/locations`, `/parameters`, `/readings` are permitted.

**Devices are called `meters` in the data and "SavIQ Device Key" in the UI.** The table is `devices`, the in-memory bucket is `state.meters`, the issue field is `meterId`. This inconsistency is deliberate — renaming would have invalidated data and backups. Live with it. Devices have an optional `name` (migration 002); the UI leads with the name and keeps the key as the identifier.

**Finding fingerprints live in Tags.** Every issue raised from Meter analysis carries `ref:<16 hex>` in its tags — a SHA-256 of `device_id|month`, matching the Python tool's `reference`. `issueByFingerprint()` matches on it, which is how re-running a month cannot create duplicates. Do not strip these tags.

**Comments and activity are separate tables**, not arrays on the issue. Issue refs (`QA-001`) come from a Postgres sequence. Both were deliberate fixes to races in the prototype. Do not collapse them back.

**Writing JS through Python heredocs in the Windows shell mangles escapes.** `—` becomes a literal em dash, `\n` inside a string becomes a real newline, large heredocs sometimes fail to parse at all. Use the Write tool for anything over a few lines, and match on literal characters, not escape sequences, when searching the file.

## The analysis port

`analysis.js` is a faithful browser port of `app_v11.py`, Ricardo's Streamlit tool. Function names follow the Python so they can be read side by side. Same thresholds, same wording, same check logic (availability, gaps, zero runs, IQR peak screening, year-on-year). Naive DEXMA timestamps are treated as UTC, as pandas did. `findingHeadlines()` produces the specific titles ("Consumption up 200% vs same month last year") — Kush asked for these after the tag names alone told him nothing.

The Streamlit app itself is not in this repo and is now retired in favour of the tab. A bridge module for it was added and removed on 16 September; do not resurrect it.

## People and roles

Ricardo Filho (admin), Anannya Gupta (9 accounts), Kushagra Shah (8), Marina Curto (4), Eyanye Ashama (0). The first person to sign in becomes admin via a database trigger; everyone after is a member. Only admins can delete issues, change roles, or reassign account ownership.

## Open items

- **SMTP** — until configured, no self-service password reset.
- **Governance** — code is in the Savills GitHub org; the Supabase project is on a personal-tier account. Should move to a Savills-owned organisation before this is the permanent home for client data. Everything ports to Azure in the Savills tenant; Supabase is plain Postgres.
- **Vercel function region** — check it is EU (`dub1`), not the US default.
- **Realtime untested** with two simultaneous users.
- **Meter analysis untested against a real DEXMA token** — the port is careful and the relay is verified, but first real run is the real test.

## History, briefly

Started 15 September 2026 as a Claude artifact with a hosted database. Proved the workflow in a day but required every user to have a Claude account, which the team did not. Ported to Supabase + Vercel on 15–16 September; the artifact was deleted. First team use 16 September; their feedback produced the owner filter, device names, Excel import, and the in-app Meter analysis tab. The original conversation that built all of this lived in a different working directory and is not available here — this file is what survived it.
