-- ============================================================================
-- Meter QA Review — database schema
-- Run this once, whole file, in the Supabase SQL Editor of a NEW project.
-- Safe to re-run: everything is created with "if not exists" or replaced.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WHO IS ALLOWED IN
--
-- Every policy below calls is_team(). Change the domain here and the whole
-- database follows. Anyone who signs up with an address outside these domains
-- can authenticate but will see an entirely empty application — reads return
-- nothing and writes are refused. That is the intended behaviour: the gate is
-- the database, not the page.
-- ----------------------------------------------------------------------------
create or replace function public.is_team()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'email', '') ~* '@savills\.ie$';
$$;

comment on function public.is_team() is
  'True when the signed-in user''s email is on an approved Savills domain. Edit the regex to change who may use the app.';

-- ----------------------------------------------------------------------------
-- TABLES
-- ----------------------------------------------------------------------------

-- People. One row per signed-in user, created automatically on first sign-in.
create table if not exists public.app_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  name        text not null,
  role        text not null default 'member' check (role in ('member','admin')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- The 21 Savills accounts. Keyed by the real account code.
create table if not exists public.accounts (
  code        text primary key,
  name        text not null,
  owner_id    uuid references public.app_users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Sites within an account.
create table if not exists public.sites (
  id           uuid primary key default gen_random_uuid(),
  account_code text not null references public.accounts(code) on delete cascade,
  name         text not null,
  created_at   timestamptz not null default now(),
  unique (account_code, name)
);

-- SavIQ devices. "ref" is the SavIQ Device Key shown throughout the UI.
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  account_code text not null references public.accounts(code) on delete cascade,
  site_id      uuid references public.sites(id) on delete set null,
  ref          text not null,
  created_at   timestamptz not null default now(),
  unique (account_code, ref)
);

-- Weekly review sessions.
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  session_date  date not null,
  title         text not null,
  status        text not null default 'live' check (status in ('live','complete')),
  notes         text not null default '',
  created_by    uuid references public.app_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- Issues. ref ("QA-001") is assigned by a sequence so two people raising an
-- issue at the same instant can never collide — the flaw in the artifact build.
create sequence if not exists public.issue_ref_seq start 1;

create table if not exists public.issues (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique default 'QA-' || lpad(nextval('public.issue_ref_seq')::text, 3, '0'),
  title         text not null,
  description   text not null default '',
  account_code  text references public.accounts(code) on delete set null,
  site_id       uuid references public.sites(id) on delete set null,
  device_id     uuid references public.devices(id) on delete set null,
  category      text not null default 'missing-data'
                check (category in ('manual-reads','salesforce','iot','missing-data','unusual-trend')),
  priority      text not null default 'medium'
                check (priority in ('low','medium','high','urgent')),
  status        text not null default 'open'
                check (status in ('open','prog','closed')),
  reporter_id   uuid references public.app_users(id) on delete set null,
  owner_id      uuid references public.app_users(id) on delete set null,
  start_date    date,
  due_date      date,
  recurrence    text not null default 'none'
                check (recurrence in ('none','weekly','monthly','quarterly')),
  tags          text[] not null default '{}',
  subtasks      jsonb  not null default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz
);

-- Comments and activity are their own tables now, not arrays on the issue.
-- Two people commenting at the same moment can no longer overwrite each other.
create table if not exists public.issue_comments (
  id         uuid primary key default gen_random_uuid(),
  issue_id   uuid not null references public.issues(id) on delete cascade,
  author_id  uuid references public.app_users(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.issue_activity (
  id         uuid primary key default gen_random_uuid(),
  issue_id   uuid not null references public.issues(id) on delete cascade,
  actor_id   uuid references public.app_users(id) on delete set null,
  text       text not null,
  created_at timestamptz not null default now()
);

-- One row per issue discussed at a review.
create table if not exists public.session_outcomes (
  session_id uuid not null references public.sessions(id) on delete cascade,
  issue_id   uuid not null references public.issues(id) on delete cascade,
  outcome    text not null check (outcome in ('closed','open','deferred')),
  note       text not null default '',
  decided_by uuid references public.app_users(id) on delete set null,
  decided_at timestamptz not null default now(),
  primary key (session_id, issue_id)
);

create index if not exists issues_account_idx   on public.issues(account_code);
create index if not exists issues_status_idx    on public.issues(status);
create index if not exists issues_owner_idx     on public.issues(owner_id);
create index if not exists issues_device_idx    on public.issues(device_id);
create index if not exists comments_issue_idx   on public.issue_comments(issue_id);
create index if not exists activity_issue_idx   on public.issue_activity(issue_id);
create index if not exists devices_account_idx  on public.devices(account_code);

-- ----------------------------------------------------------------------------
-- KEEP updated_at HONEST
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists issues_touch on public.issues;
create trigger issues_touch before update on public.issues
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- CREATE A PROFILE ON FIRST SIGN-IN
--
-- The first approved person to sign in becomes admin; everyone after is a
-- member. Name defaults to the part of the email before the @, tidied up —
-- they can correct it in Setup.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  guessed text;
  is_first boolean;
begin
  guessed := initcap(replace(replace(split_part(new.email, '@', 1), '.', ' '), '_', ' '));
  select count(*) = 0 into is_first from public.app_users;

  insert into public.app_users (id, email, name, role)
  values (new.id, new.email, coalesce(nullif(guessed, ''), new.email),
          case when is_first then 'admin' else 'member' end)
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Everything is deny-by-default. Each table then allows full access to team
-- members only. Deletes are deliberately narrower — see the notes per table.
-- ----------------------------------------------------------------------------
alter table public.app_users        enable row level security;
alter table public.accounts         enable row level security;
alter table public.sites            enable row level security;
alter table public.devices          enable row level security;
alter table public.issues           enable row level security;
alter table public.issue_comments   enable row level security;
alter table public.issue_activity   enable row level security;
alter table public.sessions         enable row level security;
alter table public.session_outcomes enable row level security;

-- Helper: is the caller an admin in the app (not just any team member)?
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users u
    where u.id = auth.uid() and u.role = 'admin'
  );
$$;

do $$
declare t text;
begin
  -- read + insert + update for every team member, on every table
  foreach t in array array['app_users','accounts','sites','devices','issues',
                           'issue_comments','issue_activity','sessions','session_outcomes']
  loop
    execute format('drop policy if exists team_select on public.%I', t);
    execute format('create policy team_select on public.%I for select using (public.is_team())', t);

    execute format('drop policy if exists team_insert on public.%I', t);
    execute format('create policy team_insert on public.%I for insert with check (public.is_team())', t);

    execute format('drop policy if exists team_update on public.%I', t);
    execute format('create policy team_update on public.%I for update using (public.is_team()) with check (public.is_team())', t);
  end loop;
end $$;

-- Deletes, tightened case by case.

-- Issues: only an admin may delete. Everyone else closes them instead.
drop policy if exists issues_delete on public.issues;
create policy issues_delete on public.issues
  for delete using (public.is_team() and public.is_app_admin());

-- Comments: you may delete your own; admins may delete any.
drop policy if exists comments_delete on public.issue_comments;
create policy comments_delete on public.issue_comments
  for delete using (public.is_team() and (author_id = auth.uid() or public.is_app_admin()));

-- Activity is an audit trail. Nobody deletes it, admins included.
-- (No delete policy = no deletes.)

-- Register housekeeping and reviews: admins only.
do $$
declare t text;
begin
  foreach t in array array['sites','devices','sessions','session_outcomes','accounts','app_users']
  loop
    execute format('drop policy if exists admin_delete on public.%I', t);
    execute format('create policy admin_delete on public.%I for delete using (public.is_team() and public.is_app_admin())', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- LIVE UPDATES
-- Add the tables to the realtime publication so every open browser sees
-- changes as they happen, the way the current app does.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['accounts','sites','devices','issues','issue_comments',
                           'issue_activity','sessions','session_outcomes','app_users']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- THE 21 ACCOUNTS
-- Seeded here rather than in the page, so the published HTML carries no
-- Savills client names. Re-running leaves existing owners untouched.
-- ----------------------------------------------------------------------------
insert into public.accounts (code, name) values
  ('8747',  'Savills Offices'),
  ('8830',  '60 Dawson St'),
  ('8831',  'Grant Thornton'),
  ('8855',  'Henderson Park'),
  ('8857',  'REAL IS'),
  ('8869',  'AM Alpha'),
  ('8871',  'DEKA'),
  ('8889',  'Union'),
  ('8962',  'ILIM'),
  ('8964',  'Westend'),
  ('8965',  'Avestus'),
  ('8966',  'Kennedy Wilson'),
  ('9137',  '28 Fitzwilliam Street'),
  ('9587',  'Bankside'),
  ('9681',  'Aviva'),
  ('9904',  'Ironworks'),
  ('9908',  'Corum'),
  ('9938',  'Swift Square'),
  ('10000', 'Cork Mathew Property Limited'),
  ('10012', 'Blanchardstown SC'),
  ('10020', 'Realty')
on conflict (code) do update set name = excluded.name;

-- ============================================================================
-- Done. Next: Authentication → Providers → enable Email, turn OFF "Confirm
-- email" only if you want instant sign-in, and leave magic links enabled.
-- Then copy your Project URL and anon key into app/config.js.
-- ============================================================================
