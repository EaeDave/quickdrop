-- A failed CREATE INDEX CONCURRENTLY leaves an invalid catalog entry that
-- would make IF NOT EXISTS skip the retry. Remove only that invalid remnant;
-- keep a valid production index untouched on idempotent migration reruns.
do $$
declare
  invalid_index regclass;
begin
  select index_class.oid::regclass
    into invalid_index
  from pg_class index_class
  join pg_index index_state on index_state.indexrelid = index_class.oid
  where index_class.oid = to_regclass('text_rooms_active_code_unique')
    and not index_state.indisvalid;

  if invalid_index is not null then
    execute format('drop index %s', invalid_index);
  end if;
end $$;
