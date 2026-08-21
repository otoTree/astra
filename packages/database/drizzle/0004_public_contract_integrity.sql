ALTER TABLE files ALTER COLUMN size_bytes TYPE bigint;

CREATE UNIQUE INDEX IF NOT EXISTS task_files_task_direction_ordinal_idx
  ON task_files(task_id, direction, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS task_files_task_file_direction_idx
  ON task_files(task_id, file_id, direction);
