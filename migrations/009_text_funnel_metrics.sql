CREATE TABLE IF NOT EXISTS text_funnel_metrics (
  metric_date date NOT NULL,
  event varchar(32) NOT NULL,
  room_kind varchar(16) NOT NULL DEFAULT 'none',
  outcome varchar(32) NOT NULL DEFAULT 'none',
  error_category varchar(32) NOT NULL DEFAULT 'none',
  count bigint NOT NULL DEFAULT 0,
  CONSTRAINT text_funnel_metrics_pk PRIMARY KEY (
    metric_date,
    event,
    room_kind,
    outcome,
    error_category
  ),
  CONSTRAINT text_funnel_metrics_event_check CHECK (
    event IN (
      'screen_opened',
      'open_or_create',
      'first_publish',
      'second_device',
      'text_copied',
      'client_error'
    )
  ),
  CONSTRAINT text_funnel_metrics_room_kind_check CHECK (
    room_kind IN ('none', 'custom', 'generated')
  ),
  CONSTRAINT text_funnel_metrics_outcome_check CHECK (
    outcome IN ('none', 'created', 'opened', 'success', 'error')
  ),
  CONSTRAINT text_funnel_metrics_error_category_check CHECK (
    error_category IN (
      'none',
      'invalid_code',
      'pin_required',
      'pin_invalid',
      'invalid_token',
      'not_found',
      'session_limit',
      'room_full',
      'too_large',
      'clipboard',
      'network',
      'unknown'
    )
  ),
  CONSTRAINT text_funnel_metrics_count_check CHECK (count >= 0)
);

COMMENT ON TABLE text_funnel_metrics IS
  'Daily aggregate text funnel counters. Never stores room codes, PINs, content, client identifiers, IPs, or user agents.';
