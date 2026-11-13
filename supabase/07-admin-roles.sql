-- =====================================================================
-- Dismissal Magic — who can do what (step 7)
--
--   School admin  = the account that owns the school, plus any emails the
--                   owner adds. Admins sign in by email and can change
--                   Settings (buses, colors, PIN). Only the owner can delete
--                   the school, manage billing, and add/remove admins.
--   Dashboard PIN = staff running dismissal. They can mark buses and call
--                   groups, but can no longer change Settings or the PIN.
--   Classroom     = anyone with the school code; view only (unchanged).
--
-- Schools made before accounts existed (no owner) keep working the old
-- PIN way so nobody gets locked out.
--
-- A district is simply an account allowed more than one school
-- (bus_accounts.school_limit) that adds an admin email for each school.
--
-- Run once in Supabase → SQL Editor, after 01–06. Safe to run again.
-- =====================================================================

create table if not exists public.bus_school_admins (
  code       text not null,
  email      text not null,
  added_at   timestamptz not null default now(),
  primary key (code, email)
);
create index if not exists bus_school_admins_email_idx on public.bus_school_admins (email);
alter table public.bus_school_admins enable row level security;
revoke all on public.bus_school_admins from anon, authenticated;


-- Helpers ---------------------------------------------------------------
create or replace function public.bus__my_email()
returns text language sql stable security definer set search_path = public as $$
  select lower(trim(coalesce(auth.jwt()->>'email', '')))
$$;

create or replace function public.bus__has_owner(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.bus_school_owners where code = upper(trim(p_code)))
$$;

create or replace function public.bus__is_owner(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.bus_school_owners where code = upper(trim(p_code)) and user_id = auth.uid())
$$;

create or replace function public.bus__is_admin(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.bus__is_owner(p_code) or (
    auth.uid() is not null and public.bus__my_email() <> '' and exists (
      select 1 from public.bus_school_admins
      where code = upper(trim(p_code)) and email = public.bus__my_email()))
$$;

revoke execute on function public.bus__my_email()       from public, anon, authenticated;
revoke execute on function public.bus__has_owner(text)  from public, anon, authenticated;
revoke execute on function public.bus__is_owner(text)   from public, anon, authenticated;
revoke execute on function public.bus__is_admin(text)   from public, anon, authenticated;


-- Am I an admin of this school? (lets the app show or hide Settings)
create or replace function public.bus_am_admin(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'ok', true,
    'admin', public.bus__is_admin(p_code),
    'owner', public.bus__is_owner(p_code),
    'legacy', not public.bus__has_owner(p_code));
end $$;
revoke execute on function public.bus_am_admin(text) from public;
grant  execute on function public.bus_am_admin(text) to anon, authenticated;


-- Settings: admins only (PIN no longer enough). Same inputs as before.
create or replace function public.bus_save_settings(p_code text, p_pin text, p_settings jsonb, p_new_pin text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_id uuid; v_err text;
begin
  select id into v_id from public.bus_schools where code = upper(trim(p_code));
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if public.bus__has_owner(p_code) then
    if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
    if not public.bus__is_admin(p_code) then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  else
    v_err := public.bus__verify(v_id, p_pin);   -- older schools: PIN, as before
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;

  if p_settings is null or length(p_settings::text) > 30000 then
    return jsonb_build_object('ok', false, 'error', 'settings_invalid');
  end if;
  if p_new_pin is not null and p_new_pin <> '' then
    if p_new_pin !~ '^[0-9]{4,8}$' then
      return jsonb_build_object('ok', false, 'error', 'pin_format');
    end if;
    update public.bus_school_secrets set pin_hash = crypt(p_new_pin, gen_salt('bf')) where school_id = v_id;
  end if;
  update public.bus_schools set settings = p_settings, updated_at = now() where id = v_id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.bus_save_settings(text, text, jsonb, text) to anon, authenticated;


-- Delete: the owner only (older schools: PIN, as before).
create or replace function public.bus_delete_school(p_code text, p_pin text, p_confirm_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare s public.bus_schools; v_err text;
  norm_a text; norm_b text;
begin
  select * into s from public.bus_schools where code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if public.bus__has_owner(p_code) then
    if not public.bus__is_owner(p_code) then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  else
    v_err := public.bus__verify(s.id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;

  norm_a := lower(regexp_replace(trim(coalesce(p_confirm_name, '')), '\s+', ' ', 'g'));
  norm_b := lower(regexp_replace(trim(coalesce(s.settings->>'name', '')), '\s+', ' ', 'g'));
  if norm_a = '' or norm_a <> norm_b then
    return jsonb_build_object('ok', false, 'error', 'name_mismatch');
  end if;
  insert into public.bus_stats_archive (day, buses_arrived, group_calls)
    select day, buses_arrived, group_calls from public.bus_daily_stats where school_id = s.id;
  delete from public.bus_school_admins where code = s.code;
  delete from public.bus_schools where id = s.id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.bus_delete_school(text, text, text) to anon, authenticated;


-- Admin list (owner only) ------------------------------------------------
create or replace function public.bus_list_admins(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.bus__is_owner(p_code) then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  return jsonb_build_object('ok', true, 'admins', coalesce((
    select jsonb_agg(jsonb_build_object('email', email, 'added_at', added_at) order by added_at)
    from public.bus_school_admins where code = upper(trim(p_code))), '[]'::jsonb));
end $$;

create or replace function public.bus_add_admin(p_code text, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.bus__is_owner(p_code) then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'error', 'email_invalid'); end if;
  if (select count(*) from public.bus_school_admins where code = upper(trim(p_code))) >= 10 then
    return jsonb_build_object('ok', false, 'error', 'admin_limit');
  end if;
  insert into public.bus_school_admins (code, email) values (upper(trim(p_code)), v_email)
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.bus_remove_admin(p_code text, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.bus__is_owner(p_code) then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  delete from public.bus_school_admins where code = upper(trim(p_code)) and email = lower(trim(p_email));
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.bus_list_admins(text)        from public, anon;
revoke execute on function public.bus_add_admin(text, text)    from public, anon;
revoke execute on function public.bus_remove_admin(text, text) from public, anon;
grant  execute on function public.bus_list_admins(text)        to authenticated;
grant  execute on function public.bus_add_admin(text, text)    to authenticated;
grant  execute on function public.bus_remove_admin(text, text) to authenticated;


-- My schools: schools I own + schools I'm an admin of, with my role.
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
    select code, created_at as since, 'owner' as role from public.bus_school_owners where user_id = v_uid
    union all
    select a.code, a.added_at, 'admin' from public.bus_school_admins a
    where a.email = public.bus__my_email()
      and not exists (select 1 from public.bus_school_owners w where w.code = a.code and w.user_id = v_uid)
    order by 2
  loop
    s := public.bus_get_school(o.code)::jsonb;
    if s is not null and jsonb_typeof(s) = 'object' then
      out := out || jsonb_build_array(jsonb_build_object(
        'code',   o.code,
        'name',   s->'settings'->>'name',
        'since',  o.since,
        'role',   o.role,
        'access', public.bus_school_access(o.code)
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'schools', out,
    'owned', (select count(*) from public.bus_school_owners where user_id = v_uid),
    'limit', coalesce((select school_limit from public.bus_accounts where user_id = v_uid), 1)
  );
end $$;

revoke execute on function public.bus_my_schools() from public, anon;
grant  execute on function public.bus_my_schools() to authenticated;
