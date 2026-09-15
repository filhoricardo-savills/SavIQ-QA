# Setting up Meter QA Review

Two accounts, about 25 minutes, no card needed. Do it in this order.

---

## 1. Supabase — the database (~10 min)

1. Go to **supabase.com**, sign up, and click **New project**.
2. Name it `meter-qa`. Generate a database password and save it in your password manager — you will rarely need it, but you cannot recover it.
3. **Region: choose an EU region** — *West EU (Ireland)* or *Central EU (Frankfurt)*. This decides where Savills client data physically lives, and **it cannot be changed later without migrating the project.** Get it right now.
4. Wait for the project to finish provisioning (a minute or two).
5. Open **SQL Editor** → **New query**. Paste the entire contents of `supabase/schema.sql`, and click **Run**.
   You should see `Success. No rows returned`. That single script creates every table, the security rules, live updates, and the 21 accounts.
6. Go to **Authentication → Providers → Email**. Make sure **Email** is enabled. Leave magic links on.
7. Go to **Project Settings → API** and copy two values:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public** key — a long string starting `eyJ...`

### Check the email domain first

Open `supabase/schema.sql` and find this line near the top:

```sql
select coalesce(auth.jwt() ->> 'email', '') ~* '@savills\.ie$';
```

**This is set to `savills.ie`.** If anyone on the team uses a different Savills domain, add it here before running the script. This one line is what keeps everyone else out — someone on an unapproved domain can still sign up, but the application will be completely empty for them, because every read and write is refused at the database. To add a second domain, change it to `~* '@(savills\.ie|savills\.com)$'` and re-run just that function.

---

## 2. Wire up the app (~2 min)

Open `config.js` and paste in the two values from step 1.7:

```js
window.QA_CONFIG = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "eyJ..."
};
```

**The anon key is meant to be public.** It goes in the page, it ends up in your GitHub repo, and that is fine — it is a publishable identifier, not a secret. Your protection is the row-level security in `schema.sql`, which is why that file matters far more than this one.

**Never put the `service_role` key here.** That one bypasses every security rule. If you ever paste it into anything public, rotate it immediately in Project Settings → API.

---

## 3. GitHub Pages — the hosting (~10 min)

1. Create a GitHub account if you do not have one.
2. Create a **new repository** called `meter-qa`. Public is fine — the page contains no Savills data now that the accounts live in the database.
3. From this folder, push the code:

   ```bash
   cd meter-qa
   git init
   git add .
   git commit -m "Meter QA Review"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/meter-qa.git
   git push -u origin main
   ```

4. In the repo: **Settings → Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: `main`**, **Folder: `/ (root)`**. Save.
5. Wait a minute or two. Your app is live at:

   ```
   https://YOUR-USERNAME.github.io/meter-qa/
   ```

---

## 4. First sign-in

1. Open the URL. Enter your Savills email.
2. Check your inbox and click the link.
3. **The first person to sign in becomes the administrator** — make sure that is you.
4. Go to **Setup**, fix your display name if the guess from your email was wrong, and assign account owners.
5. Send the link to the team. They sign in the same way; no accounts to create, no passwords.

---

## 5. Deploying on Vercel instead

If you would rather use Vercel (private repo on any plan, access control and
rollbacks on Pro):

1. **vercel.com** → **Add New → Project** → import the `meter-qa` repo.
2. Framework preset: **Other**. Root directory: **`./`**. No build command, no output directory.
3. Deploy.

Nothing in the code changes — it is the same static page either way.

**Vercel's free Hobby tier prohibits commercial use**, so a Savills tool needs
**Pro**. Do not start on Hobby intending to upgrade later.

---

## Updating the app later

Edit the files, then:

```bash
git add . && git commit -m "what changed" && git push
```

GitHub Pages redeploys in a minute or so. Same URL, so nobody needs a new link.

---

## Things worth knowing

- **Free Supabase projects pause after about a week of inactivity.** Weekly use should keep it awake; if it ever sleeps, the first load is slow while it wakes. The paid tier (around $25/month) removes this and comes with a data-processing agreement worth having once real client data is in there.
- **The app is publicly reachable; the data is not.** Anyone with the URL sees a sign-in screen. Only approved domains get past it, and only at the database level — not merely hidden in the interface.
- **Back up regularly.** Setup → *Download a JSON backup* gives you a portable copy of everything, off-platform. Supabase also runs its own scheduled backups of the database.
- **This still runs on your personal accounts.** It is the right build, on the wrong billing. Worth a conversation with Savills IT before it becomes the permanent home for client data — the whole thing ports to Azure in the Savills tenant, and because Supabase is plain Postgres, the database moves with a dump and restore.
