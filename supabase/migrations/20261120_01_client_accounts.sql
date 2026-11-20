-- Client accounts for the portal (Agent D).  NOT applied to the live database: the lead applies it later, with the owner's OK.
--
-- What this does, in plain words:
--   * a profile may now be a client (role 'client', approved, client_id = the machine's client id, e.g. 'stone-roofing');
--   * the owner makes an invite (portal_invites: only a hash of the secret token is stored); the person signs up or in,
--     then calls claim_portal_invite(token) and becomes that client;
--   * nobody can make themselves a client or an admin: sign-up always creates an unapproved employee, and a database
--     guard refuses any change to role / approved / client_id unless it comes from the owner (admin), the server, or
--     the invite claim;
--   * a client never counts as "approved staff": is_approved() is redefined to mean approved admin/employee only, so every
--     existing policy that says is_approved() keeps clients out; is_staff() and my_client_id() are the new helpers.
--
-- ASSUMPTIONS (the live definitions could not be read; adjust if they differ):
--   1. public.profiles(id uuid pk -> auth.users.id, email, name, role text, approved bool, title, loc, init, color, workload,
--      status, phone, created_at, emp_no). Today role is 'admin' or 'employee'; a new sign-up is an unapproved employee that
--      the owner approves in the hub (hub: update profiles set approved=true, role='employee', emp_no=...).
--   2. is_admin() = the caller's profile has role 'admin'; is_approved() = the caller's profile is approved.
--      Redefined below with the same meaning for admin/employee, minus clients.
--   3. handle_new_user() is an AFTER INSERT trigger on auth.users that inserts the profile (id, email, name from the sign-up
--      metadata). It keeps ignoring metadata for role / approved / client_id.
--   4. There may be an old CHECK constraint on profiles.role; any check that mentions role is replaced by one that allows
--      'admin', 'employee', 'client'.
--   5. Existing profile policies are not visible, so they are not dropped; the guard trigger and two RESTRICTIVE policies below
--      hold whatever they allow. (A restrictive policy only ever narrows access.)
--   6. Clients cannot read other people's profiles after this. Agent E's chat shows names through its own SECURITY DEFINER
--      function, not by reading profiles.

-- ── the column and the role ──────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists client_id text;
comment on column public.profiles.client_id is 'For role = client: the machine client id this person belongs to. Null for the team.';

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%' and conname <> 'profiles_role_check'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
  if exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_role_check') then
    alter table public.profiles drop constraint profiles_role_check;
  end if;
  alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'employee', 'client'));
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass and conname = 'profiles_client_has_client_id') then
    alter table public.profiles add constraint profiles_client_has_client_id check (role <> 'client' or client_id is not null);
  end if;
end $$;

create index if not exists profiles_client_id_idx on public.profiles (client_id) where client_id is not null;

-- ── helpers (everyone else uses these) ───────────────────────────────────────────────────────────
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.approved is true);
$$;

-- Approved team member (admin or employee). A client is never "approved" in this sense.
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved is true and p.role in ('admin', 'employee'));
$$;

-- Approved admin or employee.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved is true and p.role in ('admin', 'employee'));
$$;

-- The caller's client id when they are an approved client, else null.
create or replace function public.my_client_id() returns text
language sql stable security definer set search_path = public as $$
  select p.client_id from public.profiles p where p.id = auth.uid() and p.role = 'client' and p.approved is true;
$$;

revoke all on function public.is_admin(), public.is_approved(), public.is_staff(), public.my_client_id() from public, anon;
grant execute on function public.is_admin(), public.is_approved(), public.is_staff(), public.my_client_id() to authenticated, service_role;

-- ── sign-up: always an unapproved employee, whatever the sign-up form says ────────────────────────
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
-- Exactly today's live behaviour (copied from the live database on 2026-11-20): the owner's address becomes the approved
-- admin, everyone else an unapproved employee. Sign-up metadata only ever gives the name: never a role, approval or client id.
declare v_owner boolean := lower(coalesce(new.email, '')) = lower('limethsith@gmail.com');
begin
  insert into public.profiles (id, email, name, role, approved, init, emp_no, client_id)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    case when v_owner then 'admin' else 'employee' end,
    v_owner,
    upper(substr(coalesce(new.raw_user_meta_data->>'name', new.email),1,2)),
    case when v_owner then 0 else null end,
    null
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- the trigger on auth.users already exists today (it calls handle_new_user, now replaced above); make one only if missing
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgfoid = 'public.handle_new_user'::regproc and not tgisinternal) then
    create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
  end if;
end $$;

-- ── the guard: role / approved / client_id change only by the owner, the server, or an invite claim ─
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_trusted boolean;
begin
  -- trusted: no signed-in user (the dashboard / service role / auth's own sign-up insert), the owner, or claim_portal_invite
  v_trusted := auth.uid() is null or public.is_admin() or coalesce(current_setting('app.portal_claim', true), '') = 'on';
  if tg_op = 'INSERT' then
    if not v_trusted then
      new.role := 'employee'; new.approved := false; new.client_id := null;
    end if;
    return new;
  end if;
  if not v_trusted and (new.role is distinct from old.role or new.approved is distinct from old.approved or new.client_id is distinct from old.client_id) then
    raise exception 'Only the owner can change an account''s role or approval.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg before insert or update on public.profiles for each row execute function public.profiles_guard();

-- Restrictive = only narrows what the existing policies allow: a client sees and keeps only their own profile row.
drop policy if exists profiles_clients_read_own on public.profiles;
create policy profiles_clients_read_own on public.profiles as restrictive for select to authenticated
  using (public.my_client_id() is null or id = auth.uid());
drop policy if exists profiles_clients_no_delete on public.profiles;
create policy profiles_clients_no_delete on public.profiles as restrictive for delete to authenticated
  using (public.my_client_id() is null);

-- ── invites ──────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.portal_invites (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  email       text not null,
  token_hash  text not null unique,       -- sha-256 hex of the secret token (the token itself is never stored)
  created_by  uuid,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid
);
comment on table public.portal_invites is 'Invites to the client portal. Only the owner reads or writes; a person uses one through claim_portal_invite().';
create index if not exists portal_invites_client_idx on public.portal_invites (client_id);

alter table public.portal_invites enable row level security;
revoke all on public.portal_invites from anon, authenticated;
grant select, insert, update, delete on public.portal_invites to authenticated;   -- narrowed by the policy below
drop policy if exists portal_invites_admin_all on public.portal_invites;
create policy portal_invites_admin_all on public.portal_invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── claiming an invite ───────────────────────────────────────────────────────────────────────────
create or replace function public.claim_portal_invite(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_hash  text;
  v_inv   public.portal_invites%rowtype;
  v_prof  public.profiles%rowtype;
  v_has   boolean;
begin
  if v_uid is null or v_email = '' or coalesce(p_token, '') = '' or length(p_token) > 500 then
    raise exception 'This invite link is not valid any more. Ask Aviance for a new one.' using errcode = 'P0001';
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'utf8')), 'hex');

  select * into v_inv from public.portal_invites
   where token_hash = v_hash and used_at is null and expires_at > now() and lower(email) = v_email
   for update;
  if not found then
    raise exception 'This invite link is not valid any more. Ask Aviance for a new one.' using errcode = 'P0001';
  end if;

  select * into v_prof from public.profiles where id = v_uid;
  v_has := found;
  -- never turn an approved team account into a client
  if v_has and v_prof.approved is true and v_prof.role in ('admin', 'employee') then
    raise exception 'This is a team account. Use a different email for the client portal.' using errcode = 'P0001';
  end if;

  perform set_config('app.portal_claim', 'on', true);   -- this transaction only: lets the guard allow the change below
  if v_has then
    update public.profiles set role = 'client', approved = true, client_id = v_inv.client_id where id = v_uid;
  else
    insert into public.profiles (id, email, name, role, approved, client_id)
    values (v_uid, v_email, left(split_part(v_email, '@', 1), 80), 'client', true, v_inv.client_id);
  end if;
  perform set_config('app.portal_claim', 'off', true);

  update public.portal_invites set used_at = now(), used_by = v_uid where id = v_inv.id;
  return v_inv.client_id;
end $$;

revoke all on function public.claim_portal_invite(text) from public, anon;
grant execute on function public.claim_portal_invite(text) to authenticated;
