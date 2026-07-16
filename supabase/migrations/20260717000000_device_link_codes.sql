-- Device-link sign-in: a signed-in PC generates a short-lived code; the
-- tablet claims it through the link-device Edge Function (service role) and
-- receives a one-time token to establish its own session. No browser/OAuth
-- round-trip needed on the device.
--
-- No RLS policies on purpose: only the Edge Function (service role) touches
-- this table besides the authenticated creator inserting their own code.

create table if not exists public.device_link_codes (
  code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.device_link_codes enable row level security;

drop policy if exists "Users create own link codes" on public.device_link_codes;
create policy "Users create own link codes"
  on public.device_link_codes for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own link codes" on public.device_link_codes;
create policy "Users delete own link codes"
  on public.device_link_codes for delete
  using (auth.uid() = user_id);
