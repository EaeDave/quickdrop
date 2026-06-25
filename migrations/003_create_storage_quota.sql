create table if not exists storage_quota (
    id varchar(32) primary key,
    active_bytes bigint not null default 0,
    reserved_bytes bigint not null default 0,
    updated_at timestamptz not null
);

insert into storage_quota (id, active_bytes, reserved_bytes, updated_at)
values (
    'global',
    coalesce((select sum(size_bytes) from uploads where deleted_at is null), 0),
    0,
    now()
)
on conflict (id) do nothing;

create table if not exists storage_reservations (
    id uuid primary key,
    size_bytes bigint not null,
    created_at timestamptz not null,
    expires_at timestamptz not null
);

create index if not exists storage_reservations_expires_idx
  on storage_reservations (expires_at);
