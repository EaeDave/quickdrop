-- Keep this as a standalone statement: CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block and allows text-room writes during the build.
create unique index concurrently if not exists text_rooms_active_code_unique
  on text_rooms (code)
  where deleted_at is null;
