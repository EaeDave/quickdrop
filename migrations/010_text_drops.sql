ALTER TABLE text_rooms
  ADD COLUMN IF NOT EXISTS drops_started_at timestamptz;

CREATE TABLE IF NOT EXISTS text_drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES text_rooms(id) ON DELETE CASCADE,
  content text NOT NULL,
  content_type varchar(16) NOT NULL DEFAULT 'text',
  legacy_room_version integer,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT text_drops_content_not_empty CHECK (length(content) > 0),
  CONSTRAINT text_drops_content_type_check CHECK (
    content_type IN ('text', 'url', 'command', 'json')
  )
);

CREATE INDEX IF NOT EXISTS text_drops_room_timeline_idx
  ON text_drops (room_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS text_drops_expiry_idx
  ON text_drops (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS text_drops_legacy_room_version_unique
  ON text_drops (room_id, legacy_room_version)
  WHERE legacy_room_version IS NOT NULL;

-- Preserve the last document from every existing room as its first immutable drop.
-- The partial unique index makes this backfill safe to run repeatedly.
INSERT INTO text_drops (
  room_id,
  content,
  content_type,
  legacy_room_version,
  created_at,
  expires_at
)
SELECT
  id,
  text,
  'text',
  version,
  updated_at,
  CASE
    WHEN expires_at IS NULL THEN now() + interval '12 hours'
    ELSE expires_at
  END
FROM text_rooms
WHERE text <> ''
ON CONFLICT (room_id, legacy_room_version)
  WHERE legacy_room_version IS NOT NULL
DO NOTHING;

UPDATE text_rooms
SET drops_started_at = updated_at
WHERE drops_started_at IS NULL
  AND text <> '';
