-- Per-user interface language.
--
-- Default 'de': the app was authored in German, so an existing user keeps what
-- they have always seen until they pick otherwise. No CHECK constraint on the
-- value on purpose -- the set of languages lives in the frontend
-- (lib/language.svelte.ts), and a column constraint would mean a DB migration
-- every time one is added. An unknown value falls back to the default at read.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'de';
