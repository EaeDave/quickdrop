do $$
declare
  primary_key_name text;
  primary_key_column text;
begin
  select usage.constraint_name, usage.column_name
    into primary_key_name, primary_key_column
  from information_schema.key_column_usage usage
  join information_schema.table_constraints constraints
    on constraints.constraint_schema = usage.constraint_schema
   and constraints.constraint_name = usage.constraint_name
   and constraints.table_name = usage.table_name
  where usage.table_schema = current_schema()
    and usage.table_name = 'text_rooms'
    and constraints.constraint_type = 'PRIMARY KEY'
  order by usage.ordinal_position
  limit 1;

  if primary_key_column = 'code' then
    execute format('alter table text_rooms drop constraint %I', primary_key_name);
    alter table text_rooms alter column id set not null;
    alter table text_rooms add primary key (id);
  end if;

  alter table text_rooms drop constraint if exists text_rooms_id_not_null;
end $$;
