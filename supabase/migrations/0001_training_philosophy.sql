-- Add training_philosophy column to public.profiles.
-- Captured once in the first Cook chat session (not in onboarding).
-- Run via Supabase SQL editor or psql. Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS training_philosophy text DEFAULT NULL;
