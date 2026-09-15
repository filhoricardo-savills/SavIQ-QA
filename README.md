# SavIQ Meter QA Review

Weekly data-quality issue tracker for SavIQ metering data across the Savills-managed accounts.

**Live:** https://sav-iq-qa.vercel.app
**Architecture map:** [`docs/architecture.html`](docs/architecture.html) — open it in a browser, or at `/docs/architecture.html` on the deployed site.

---

## What it is for

During the week, the team raises issues against an account — a manual read that never arrived, an IoT logger dropping overnight, a consumption trend that does not match occupancy. At the weekly call, the open list is walked one item at a time and each is marked **Closed**, **Still open** or **Deferred**. Anything not closed is counted as carried, with the number of weeks visible, so a long-running problem surfaces instead of quietly recurring.

## How it runs

A single static HTML page talking directly to Supabase. There is no server of ours, no build step and no framework.

| Piece | Role |
|---|---|
| **GitHub** | The source. A push to `main` is the deployment. |
| **Vercel** | Serves two static files worldwide. Rollback is picking an earlier deployment. |
| **Supabase** | Postgres in an EU region, plus auth and realtime. |

`config.js` holds the Supabase project URL and publishable key. **Both are meant to be public** — the key identifies the project, it does not grant access. Protection comes from the row-level security in `supabase/schema.sql`, which denies everything by default and then allows only a verified `@savills.ie` address. Verified from outside: anonymous reads return empty, anonymous writes are refused.

The `service_role` key must never appear in this repo.

## Layout

| Path | |
|---|---|
| `index.html` | The whole application |
| `config.js` | Supabase project URL and publishable key |
| `supabase/schema.sql` | Tables, security policies, realtime, seeded accounts |
| `docs/architecture.json` | Typed source for the architecture map |
| `docs/architecture.html` | Rendered, self-contained map |
| `SETUP.md` | Standing up a fresh instance from nothing |

## Changing it

```bash
git add . && git commit -m "what changed" && git push
```

Vercel redeploys in about a minute. Same URL.

The app is one file, assembled by hand rather than built. Edit `index.html` directly.

To regenerate the architecture map after a structural change:

```bash
node ~/.agents/skills/archify/bin/archify.mjs deliver architecture \
  docs/architecture.json docs/architecture.html \
  --quality showcase --repo-root "$(git rev-parse --show-toplevel)"
```

It verifies that every `sources` path in the JSON still exists, so the map cannot silently drift from the code.

## Data model

Nine tables. `issues` is the centre; `issue_comments`, `issue_activity` and `session_outcomes` hang off it; `accounts`, `sites` and `devices` describe what an issue is about; `app_users` holds people; `sessions` holds weekly reviews.

Two decisions worth not reversing:

- **Comments and activity are their own tables**, not arrays on the issue. Two people commenting at the same moment cannot overwrite each other.
- **Issue references come from a Postgres sequence**, so `QA-001` can never be handed out twice.

Fixed vocabularies live at the top of `index.html`: issue types (Manual reads, Salesforce, IoT, Missing data, Unusual trend), statuses (Open → In progress → Closed), priorities, and recurrence.

## Sign-in

Email and password. Deliberately not a sign-in link: Savills mail security pre-fetches every URL it delivers, which spends a single-use link before the recipient can click it.

The first person to sign in becomes administrator; everyone after is a member. Admins manage roles and account ownership. People appear in **Setup** the first time they sign in — there is nobody to invite.

## Known gaps

- **No password reset.** Supabase's built-in mail is rate-limited on the free tier and no custom SMTP is configured, so a forgotten password currently needs a SQL update against `auth.users`. Configuring SMTP fixes this properly.
- **Free-tier Supabase pauses** after about a week idle. Weekly use should keep it awake.
- **Governance.** The Supabase project sits on a personal-tier account rather than a Savills-owned organisation. The code is in the Savills GitHub org; the database is not yet. Worth resolving before this becomes the long-term home for client data — the whole thing ports to Azure in the Savills tenant, and because Supabase is plain Postgres the database moves with a dump and restore.
