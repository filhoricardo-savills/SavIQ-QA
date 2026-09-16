-- ============================================================================
-- Migration 002 — device names
--
-- Marina's point: a SavIQ Device Key like 10012345678 means nothing to a human.
-- Devices now carry an optional friendly name, shown first everywhere a device
-- appears, with the key kept as the identifier.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- ============================================================================

alter table public.devices
  add column if not exists name text;

comment on column public.devices.name is
  'Human-readable device label, for example "ELEC_Main incomer". Optional. The key (ref) remains the unique identifier within an account.';

-- Helps the register and the device-health view sort by what people read.
create index if not exists devices_name_idx on public.devices (account_code, name);

-- ============================================================================
-- Done. Nothing else to change: existing devices simply have no name until
-- someone adds one, and every screen falls back to the key.
-- ============================================================================
