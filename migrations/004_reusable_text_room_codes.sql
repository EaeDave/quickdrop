-- Add the new identity without a volatile default so PostgreSQL does not
-- rewrite the existing table while taking an ACCESS EXCLUSIVE lock.
alter table text_rooms
  add column if not exists id uuid;

alter table text_rooms
  alter column id set default gen_random_uuid();

-- The service limits active rooms to a small bounded set (500 by default).
-- Existing rows are backfilled before the validated constraint allows the
-- later primary-key swap to skip a blocking NOT NULL table scan.
update text_rooms
set id = gen_random_uuid()
where id is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'text_rooms'::regclass
      and conname = 'text_rooms_id_not_null'
  ) and not exists (
    select 1
    from pg_constraint
    where conrelid = 'text_rooms'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) then
    alter table text_rooms
      add constraint text_rooms_id_not_null check (id is not null) not valid;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'text_rooms'::regclass
      and conname = 'text_rooms_id_not_null'
  ) then
    alter table text_rooms validate constraint text_rooms_id_not_null;
  end if;
end $$;
