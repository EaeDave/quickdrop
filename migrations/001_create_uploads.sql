create table if not exists uploads (
    id uuid primary key,
    short_id varchar(32) unique not null,
    original_name text not null,
    mime_type text,
    size_bytes bigint not null,
    r2_key text not null,
    download_count integer default 0,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    deleted_at timestamptz
);

create index if not exists uploads_expired_cleanup_idx
  on uploads (expires_at)
  where deleted_at is null;
