alter table text_rooms
  add column if not exists id uuid default gen_random_uuid();

update text_rooms
set id = gen_random_uuid()
where id is null;

alter table text_rooms
  alter column id set default gen_random_uuid(),
  alter column id set not null;

do $$
declare
  primary_key_name text;
  primary_key_column text;
begin
  select constraint_name, column_name
    into primary_key_name, primary_key_column
  from information_schema.key_column_usage
  where table_schema = current_schema()
    and table_name = 'text_rooms'
    and constraint_name in (
      select constraint_name
      from information_schema.table_constraints
      where table_schema = current_schema()
        and table_name = 'text_rooms'
        and constraint_type = 'PRIMARY KEY'
    )
  order by ordinal_position
  limit 1;

  if primary_key_column = 'code' then
    execute format('alter table text_rooms drop constraint %I', primary_key_name);
    primary_key_name := null;
  end if;

  if primary_key_name is null then
    alter table text_rooms add primary key (id);
  end if;
end $$;

create unique index if not exists text_rooms_active_code_unique
  on text_rooms (code)
  where deleted_at is null;
