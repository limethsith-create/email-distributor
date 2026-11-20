-- People limit per plan (Agent E). NOT applied to the live database: the lead applies it later, with the owner's OK.
-- Starter 2, Growth 4, Scale 6 client people per client (the team never counts). The machine config decides the number
-- (PORTAL.seats); the hub writes it into client_seats when the owner invites or opens a client. This file is the hard limit.
--   * a client with no client_seats row has no limit yet (the owner has not set a plan); the hub always writes the row on invite;
--   * clients may invite their own people (insert into portal_invites for their OWN client id), up to the limit;
--   * a new invite, and a claim that would make someone a client, is refused beyond the limit.
-- Uses D's helpers (is_admin, is_staff, my_client_id) and portal_invites / profiles. Never redefines them.

create table if not exists public.client_seats (
  client_id  text primary key,
  seats      int  not null check (seats between 1 and 100),
  updated_at timestamptz not null default now()
);
comment on table public.client_seats is 'How many client people each client may have (from their plan). The owner writes it; a client can read their own row.';
alter table public.client_seats enable row level security;
revoke all on public.client_seats from anon;
grant select, insert, update, delete on public.client_seats to authenticated;
drop policy if exists client_seats_admin_all on public.client_seats;
create policy client_seats_admin_all on public.client_seats for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists client_seats_client_read on public.client_seats;
create policy client_seats_client_read on public.client_seats for select to authenticated
  using (client_id = public.my_client_id());

-- People used = client accounts + invites not used and not expired.
create or replace function public.seats_used(p_client_id text) returns int
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.profiles p where p.role = 'client' and p.client_id = p_client_id)::int
       + (select count(*) from public.portal_invites i where i.client_id = p_client_id and i.used_at is null and i.expires_at > now())::int;
$$;
revoke all on function public.seats_used(text) from public, anon;
grant execute on function public.seats_used(text) to authenticated, service_role;

-- The client's own people: accounts and waiting invites (clients cannot read profiles or invites directly).
create or replace function public.my_people() returns table (kind text, name text, email text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select 'person'::text, p.name, p.email, null::timestamptz from public.profiles p
   where public.my_client_id() is not null and p.role = 'client' and p.client_id = public.my_client_id()
  union all
  select 'invited'::text, null::text, i.email, i.expires_at from public.portal_invites i
   where public.my_client_id() is not null and i.client_id = public.my_client_id() and i.used_at is null and i.expires_at > now()
  order by 1, 3;
$$;
revoke all on function public.my_people() from public, anon;
grant execute on function public.my_people() to authenticated;

-- ── a new invite: within the limit; a client's own invite is kept narrow ──────────────────────────
create or replace function public.portal_invites_seat_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_seats int;
begin
  if auth.uid() is not null and not public.is_admin() then
    -- a client inviting: only their own client, only an email + token, short life, created by them
    if new.client_id is distinct from public.my_client_id() then
      raise exception 'You can only invite people to your own account.' using errcode = '42501';
    end if;
    if new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(new.email) > 254 then
      raise exception 'That email address does not look right.' using errcode = 'P0001';
    end if;
    new.created_by := auth.uid(); new.used_at := null; new.used_by := null;
    new.expires_at := least(new.expires_at, now() + interval '14 days');
  end if;
  select seats into v_seats from public.client_seats where client_id = new.client_id;
  if v_seats is not null and public.seats_used(new.client_id) >= v_seats then
    raise exception 'You''ve reached the limit for your plan (% people).', v_seats using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists portal_invites_seat_guard_trg on public.portal_invites;
create trigger portal_invites_seat_guard_trg before insert on public.portal_invites
  for each row execute function public.portal_invites_seat_guard();

-- a client may add an invite for their own client id (the trigger above does the rest)
drop policy if exists portal_invites_client_insert on public.portal_invites;
create policy portal_invites_client_insert on public.portal_invites for insert to authenticated
  with check (client_id = public.my_client_id() and created_by = auth.uid());

-- ── a claim that makes someone a client: within the limit (their own invite is already counted) ───
create or replace function public.profiles_seat_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_seats int; v_taken int;
begin
  if new.role = 'client' and new.client_id is not null
     and (tg_op = 'INSERT' or old.role is distinct from 'client' or old.client_id is distinct from new.client_id) then
    select seats into v_seats from public.client_seats where client_id = new.client_id;
    if v_seats is not null then
      select count(*) into v_taken from public.profiles p where p.role = 'client' and p.client_id = new.client_id and p.id <> new.id;
      if v_taken >= v_seats then
        raise exception 'You''ve reached the limit for your plan (% people).', v_seats using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_seat_guard_trg on public.profiles;
create trigger profiles_seat_guard_trg before insert or update on public.profiles
  for each row execute function public.profiles_seat_guard();
