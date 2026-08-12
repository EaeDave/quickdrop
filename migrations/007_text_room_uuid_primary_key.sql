do $$
declare
  primary_key_name text;
  primary_key_columns text[];
begin
  select constraint_state.conname,
         array_agg(attribute_state.attname order by key_state.ordinality)
    into primary_key_name, primary_key_columns
  from pg_constraint constraint_state
  cross join lateral unnest(constraint_state.conkey)
    with ordinality as key_state(attnum, ordinality)
  join pg_attribute attribute_state
    on attribute_state.attrelid = constraint_state.conrelid
   and attribute_state.attnum = key_state.attnum
  where constraint_state.conrelid = 'text_rooms'::regclass
    and constraint_state.contype = 'p'
  group by constraint_state.conname;

  if primary_key_columns = array['code']::text[] then
    execute format('alter table text_rooms drop constraint %I', primary_key_name);
    alter table text_rooms alter column id set not null;
    alter table text_rooms add primary key (id);
    alter table text_rooms drop constraint if exists text_rooms_id_not_null;
  elsif primary_key_columns = array['id']::text[] then
    -- A previous partial run already reached the required end state.
    alter table text_rooms drop constraint if exists text_rooms_id_not_null;
  else
    raise exception 'Unexpected text_rooms primary key columns: %', primary_key_columns;
  end if;
end $$;
