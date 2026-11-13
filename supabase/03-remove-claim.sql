-- =====================================================================
-- Dismissal Magic — turn off "Add a school you already set up"
-- Every school is now linked to an account when it's created, so linking
-- an older school with its code + PIN is no longer needed.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================
drop function if exists public.bus_claim_school(text, text);
