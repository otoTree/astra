ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS maturity text;
UPDATE model_releases SET model_id = alias WHERE model_id IS NULL;
UPDATE model_releases SET maturity = 'stable' WHERE maturity IS NULL;
ALTER TABLE model_releases ALTER COLUMN model_id SET NOT NULL;
ALTER TABLE model_releases ALTER COLUMN maturity SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE model_releases ADD CONSTRAINT model_releases_maturity_check
    CHECK (maturity IN ('candidate', 'stable', 'deprecated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS model_releases_enabled_alias_idx
  ON model_releases(alias, created_at DESC, id) WHERE accept_new_tasks = true;

DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_operation_check CHECK (operation IN ('generation', 'edit'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS tasks_project_type_created_idx ON tasks(project_id, type, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tasks_project_priority_created_idx ON tasks(project_id, priority, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tasks_project_status_created_idx ON tasks(project_id, status, created_at DESC, id DESC);

ALTER TABLE files ADD COLUMN IF NOT EXISTS media jsonb;
ALTER TABLE files ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE files SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE files ALTER COLUMN updated_at SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE files ADD CONSTRAINT files_status_check
    CHECK (status IN ('pending_upload', 'validating', 'available', 'rejected', 'expiring', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS files_expiration_idx ON files(status, expires_at, id)
  WHERE status IN ('pending_upload', 'available', 'expiring');

UPDATE model_releases
SET manifest = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(manifest, '{operations}', '["generation","edit"]'::jsonb, true),
      '{capabilities,input_roles}',
      '["reference_image","first_frame","last_frame","reference_video","source_video","reference_audio","reference_video_audio","source_audio"]'::jsonb,
      true
    ),
    '{maturity}',
    '"stable"'::jsonb,
    true
  ),
  '{capabilities,image}',
  '{"sizes":["608x352","448x448"],"qualities":["standard","high"],"formats":["png","jpeg","webp"],"max_outputs":4,"input_roles":["reference_image","mask"]}'::jsonb,
  true
)
WHERE id = 'release_local_reference';
