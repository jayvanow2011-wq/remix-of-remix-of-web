ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS tag text,
  ADD COLUMN IF NOT EXISTS wd_exclusion boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_admin boolean NOT NULL DEFAULT false;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS tag text;