-- =====================================================================
-- Dismissal Magic — free trial + "is this school paid up?" check
-- (launch checklist: free trial + check payment in the database)
--
--   * Each ACCOUNT gets one 30-day free trial, starting when it makes its
--     first school. Making more schools (or deleting and re-making one)
--     doesn't restart it.
--   * A school can call buses when: it's paid up, OR it's comped (free),
--     OR its owner's trial is still running.
--   * When none of those is true, calling buses is blocked IN THE DATABASE,
--     so nobody can get around it from the page. Classroom screens keep
--     working; they just stop getting new calls. Settings and Delete still work.
--   * Schools on the allyn@stemstarters.com account are comped (free pilot).
--
-- Run once in Supabase → SQL Editor, after 01–03. Safe to run again.
-- =====================================================================

-- One row per account: when its free trial ends.
create table if not exists public.bus_accounts (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  trial_ends_at timestamptz not null,
  created_at    timestamptz not null default now()
);
alter table public.bus_accounts enable row level security;
revoke all on public.bus_accounts from anon, authenticated;

-- One row per paying (or comped) school. Stripe will fill this in later.
create table if not exists public.bus_school_billing (
  code                   text primary key,
  paid_until             timestamptz,
  comped                 boolean not null default false,
  plan                   text,            -- 'founding' | 'regular' | 'district' | …
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text,            -- Stripe's subscription status
  updated_at             timestamptz not null default now()
);
alter table public.bus_school_billing enable row level security;
revoke all on public.bus_school_billing from anon, authenticated;

-- Accounts that already have schools: trial = 30 days after their first school.
insert into public.bus_accounts (user_id, trial_ends_at)
select user_id, min(created_at) + interval '30 days'
from public.bus_school_owners
group by user_id
on conflict (user_id) do nothing;

-- Free pilot: comp every school on Allyn's account.
insert into public.bus_school_billing (code, comped, plan)
select o.code, true, 'comped'
from public.bus_school_owners o
join auth.users u on u.id = o.user_id
where lower(u.email) = 'allyn@stemstarters.com'
on conflict (code) do update set comped = true, plan = 'comped', updated_at = now();


-- ---------------------------------------------------------------------
-- Access status for one school (safe to show anyone with the code:
-- it says nothing but trial/paid status and dates).
-- ---------------------------------------------------------------------
create or replace function public.bus_school_access(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_code  text := upper(trim(p_code));
  b       public.bus_school_billing%rowtype;
  v_trial timestamptz;
begin
  select * into b from public.bus_school_billing where code = v_code;

  if found and b.comped then
    return jsonb_build_object('active', true, 'reason', 'comped');
  end if;
  if found and b.paid_until is not null and b.paid_until > now() then
    return jsonb_build_object('active', true, 'reason', 'paid', 'paid_until', b.paid_until, 'plan', b.plan);
  end if;

  select a.trial_ends_at into v_trial
  from public.bus_school_owners o
  join public.bus_accounts a on a.user_id = o.user_id
  where o.code = v_code;

  if v_trial is not null and v_trial > now() then
    return jsonb_build_object('active', true, 'reason', 'trial', 'trial_ends_at', v_trial,
                              'days_left', greatest(1, ceil(extract(epoch from (v_trial - now())) / 86400)::int));
  end if;

  return jsonb_build_object('active', false, 'reason', 'expired', 'trial_ends_at', v_trial,
                            'paid_until', case when found then b.paid_until end);
end $$;

revoke execute on function public.bus_school_access(text) from public;
grant  execute on function public.bus_school_access(text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- Create a school: same as before (signed in, max 3), and now also starts
-- the account's one free trial the first time.
-- ---------------------------------------------------------------------
create or replace function public.bus_create_school_owned(p_settings jsonb, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_limit int  := 3;
  r jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;

  perform pg_advisory_xact_lock(hashtext('bus_owner:' || v_uid::text));
  if (select count(*) from public.bus_school_owners where user_id = v_uid) >= v_limit then
    return jsonb_build_object('ok', false, 'error', 'school_limit', 'limit', v_limit);
  end if;

  r := public.bus_create_school(p_settings, p_pin)::jsonb;

  if coalesce((r->>'ok')::boolean, false) and r ? 'code' then
    insert into public.bus_school_owners (code, user_id)
    values (r->>'code', v_uid)
    on conflict (code) do nothing;

    insert into public.bus_accounts (user_id, trial_ends_at)
    values (v_uid, now() + interval '30 days')
    on conflict (user_id) do nothing;     -- one trial per account, ever
  end if;

  return r;
end $$;

revoke execute on function public.bus_create_school_owned(jsonb, text) from public, anon;
grant  execute on function public.bus_create_school_owned(jsonb, text) to authenticated;


-- ---------------------------------------------------------------------
-- My schools: now includes each school's access status.
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
        'code',   o.code,
        'name',   s->'settings'->>'name',
        'since',  o.created_at,
        'access', public.bus_school_access(o.code)
      ));
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'schools', out);
end $$;

revoke execute on function public.bus_my_schools() from public, anon;
grant  execute on function public.bus_my_schools() to authenticated;


-- ---------------------------------------------------------------------
-- The lock: calling buses (bus_save_state) only works for active schools.
-- The original function is renamed to bus_save_state_core (no longer
-- callable from the browser) and a same-named wrapper checks access first.
-- ---------------------------------------------------------------------
do $$
declare
  v_args text;   -- full argument list (with any defaults), for CREATE
  v_ids  text;   -- argument types only, for GRANT/REVOKE
  v_ret  text;
  v_core regprocedure;
begin
  -- 1) Rename the original once (skip if already done on an earlier run).
  if not exists (select 1 from pg_proc where proname = 'bus_save_state_core' and pronamespace = 'public'::regnamespace) then
    execute (
      select format('alter function %s rename to bus_save_state_core', p.oid::regprocedure)
      from pg_proc p
      where p.proname = 'bus_save_state' and p.pronamespace = 'public'::regnamespace
      limit 1
    );
  end if;

  select p.oid::regprocedure, pg_get_function_arguments(p.oid), pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid)
    into v_core, v_args, v_ids, v_ret
  from pg_proc p
  where p.proname = 'bus_save_state_core' and p.pronamespace = 'public'::regnamespace
  limit 1;

  -- 2) Nobody calls the core directly any more.
  execute format('revoke execute on function %s from public, anon, authenticated', v_core);

  -- 3) Same name + same inputs as before, so the app doesn't change how it calls it.
  execute format($f$
    create or replace function public.bus_save_state(%s)
    returns %s
    language plpgsql
    security definer
    set search_path = public
    as $body$
    begin
      if not coalesce((public.bus_school_access(p_code)->>'active')::boolean, false) then
        return jsonb_build_object('ok', false, 'error', 'subscription_needed')::%s;
      end if;
      return public.bus_save_state_core(p_code, p_pin, p_state, p_expected_version);
    end
    $body$;
  $f$, v_args, v_ret, v_ret);

  execute format('revoke execute on function public.bus_save_state(%s) from public', v_ids);
  execute format('grant execute on function public.bus_save_state(%s) to anon, authenticated', v_ids);
end $$;
