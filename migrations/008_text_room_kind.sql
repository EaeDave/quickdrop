alter table text_rooms
  add column if not exists kind varchar(16) not null default 'generated';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'text_rooms'::regclass
      and conname = 'text_rooms_kind_valid'
  ) then
    alter table text_rooms
      add constraint text_rooms_kind_valid
      check (kind in ('custom', 'generated')) not valid;
  end if;
end $$;

alter table text_rooms validate constraint text_rooms_kind_valid;
