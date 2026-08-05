-- Instance settings an admin changes at runtime (docs/03 §3.3.21). A key-value table rather than a
-- column per setting: these are operational knobs, they arrive one at a time, and a migration per
-- knob is a migration nobody wants to write. The value is JSON so a setting can be a number today
-- and a shape tomorrow without another migration.
--
-- Not a replacement for env: the env values stay the defaults (docs/12 §12.4), and a row here is
-- somebody overriding one deliberately.
CREATE TABLE "settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);
