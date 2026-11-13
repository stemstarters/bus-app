-- =====================================================================
-- Dismissal Magic — school accounts (launch checklist step 1)
--
-- What this does:
--   * Creating a school now needs a signed-in account (email magic link).
--   * Each school is linked to the account that owns it.
--   * Owners can see "My schools" and add a school they set up before
--     accounts existed (school code + PIN).
--   * Classroom screens and the PIN-based master panel work exactly as before.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- It only ADDS things named bus_…; it doesn't change your existing functions,
-- except that the old bus_create_school can no longer be called from the browser.
-- =====================================================================

create table if not exists public.bus_school_owners (
  code       text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists bus_school_owners_user_idx on public.bus_school_owners (user_id);

-- Locked table: no policies, so the browser can't read or change it directly.
-- Only the functions below (which run as the database owner) touch it.
alter table public.bus_school_owners enable row level security;
revoke all on public.bus_school_owners from anon, authenticated;


-- ---------------------------------------------------------------------
-- Create a school (signed in only). Wraps the existing bus_create_school.
-- ---------------------------------------------------------------------
create or replace function public.bus_create_school_owned(p_settings jsonb, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  r jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  r := public.bus_create_school(p_settings, p_pin)::jsonb;

  if coalesce((r->>'ok')::boolean, false) and r ? 'code' then
    insert into public.bus_school_owners (code, user_id)
    values (r->>'code', v_uid)
    on conflict (code) do nothing;
  end if;

  return r;
end $$;


-- ---------------------------------------------------------------------
-- The signed-in owner's schools: [{code, name, since}]
-- ---------------------------------------------------------------------
create or replace function public.bus_my_schools()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  o record;
  s jsonb;
  out jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  for o in
    select code, created_at from public.bus_school_owners
    where user_id = v_uid
    order by created_at
  loop
    s := public.bus_get_school(o.code)::jsonb;
    if s is not null and jsonb_typeof(s) = 'object' then
      out := out || jsonb_build_array(jsonb_build_object(
        'code',  o.code,
        'name',  s->'settings'->>'name',
        'since', o.created_at
      ));
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'schools', out);
end $$;


-- ---------------------------------------------------------------------
-- Add a school that was set up before accounts (needs its code + PIN).
-- Only works if no other account owns it yet. (Removed later by 03-remove-claim.sql.)
-- ---------------------------------------------------------------------
create or replace function public.bus_claim_school(p_code text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text := upper(trim(p_code));
  v_owner uuid;
  r jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  -- Uses the existing PIN check, so wrong tries count toward the 15-minute lock.
  r := public.bus_check_pin(v_code, p_pin)::jsonb;
  if not coalesce((r->>'ok')::boolean, false) then
    return r;
  end if;

  select user_id into v_owner from public.bus_school_owners where code = v_code;
  if v_owner = v_uid then
    return jsonb_build_object('ok', true, 'code', v_code, 'already', true);
  elsif v_owner is not null then
    return jsonb_build_object('ok', false, 'error', 'owned');
  end if;

  insert into public.bus_school_owners (code, user_id) values (v_code, v_uid);
  return jsonb_build_object('ok', true, 'code', v_code);
end $$;


-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
-- New functions: signed-in users only.
revoke execute on function public.bus_create_school_owned(jsonb, text) from public, anon;
revoke execute on function public.bus_my_schools()                     from public, anon;
revoke execute on function public.bus_claim_school(text, text)         from public, anon;
grant  execute on function public.bus_create_school_owned(jsonb, text) to authenticated;
grant  execute on function public.bus_my_schools()                     to authenticated;
grant  execute on function public.bus_claim_school(text, text)         to authenticated;

-- The old create function can no longer be called from the browser,
-- so nobody can make a school without an account.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
    where p.proname = 'bus_create_school' and p.pronamespace = 'public'::regnamespace
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
