create table if not exists text_rooms (
    code varchar(16) primary key,
    text text not null default '',
    version integer not null default 0,
    pin_hash text,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    expires_at timestamptz,
    deleted_at timestamptz
);

create index if not exists text_rooms_expires_idx
  on text_rooms (expires_at)
  where deleted_at is null;
