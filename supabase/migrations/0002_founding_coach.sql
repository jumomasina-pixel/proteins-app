-- Founding Coach tier — Phase 1 schema.
-- Adds coach role + referral system columns to public.profiles.
-- Run via Supabase SQL editor or psql. Idempotent — safe to re-run.

-- role already exists on this table; keep IF NOT EXISTS so the migration is safe everywhere.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role          text    DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS referral_slug text,                     -- coach's unique link slug
  ADD COLUMN IF NOT EXISTS referred_by   text,                     -- slug of the coach who referred this user
  ADD COLUMN IF NOT EXISTS client_count  integer DEFAULT 0;        -- maintained on coach rows only

-- Unique constraint on referral_slug — Postgres allows multiple NULLs by default, so non-coach
-- rows with NULL slugs do not collide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'profiles_referral_slug_key'
  ) THEN
    CREATE UNIQUE INDEX profiles_referral_slug_key
      ON public.profiles (referral_slug)
      WHERE referral_slug IS NOT NULL;
  END IF;
END $$;
