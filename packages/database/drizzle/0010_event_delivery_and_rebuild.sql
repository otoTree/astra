ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS aggregate_version integer NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS trace_id text NOT NULL DEFAULT 'trace_unavailable';

CREATE TABLE IF NOT EXISTS event_relay_deliveries (
  event_id text NOT NULL REFERENCES outbox_events(id),
  sink text NOT NULL CHECK (sink IN ('kafka', 'redis')),
  status text NOT NULL CHECK (status IN ('pending', 'leased', 'retry_wait', 'delivered', 'dead_letter')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  destination_metadata jsonb,
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, sink),
  CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS event_relay_deliveries_claim_idx
  ON event_relay_deliveries(sink, next_attempt_at, event_id)
  WHERE status IN ('pending', 'retry_wait', 'leased');
CREATE INDEX IF NOT EXISTS outbox_events_aggregate_order_idx
  ON outbox_events(aggregate_id, created_at, id);

CREATE TABLE IF NOT EXISTS event_dead_letters (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES outbox_events(id),
  sink text NOT NULL CHECK (sink IN ('kafka', 'redis')),
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  error_code text NOT NULL,
  payload_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  UNIQUE (event_id, sink, created_at)
);
CREATE INDEX IF NOT EXISTS event_dead_letters_open_idx
  ON event_dead_letters(created_at, id) WHERE replayed_at IS NULL;

CREATE TABLE IF NOT EXISTS event_consumer_receipts (
  consumer_name text NOT NULL,
  event_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE IF NOT EXISTS redis_index_generations (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('building', 'active', 'retired', 'failed')),
  started_outbox_created_at timestamptz,
  started_outbox_id text,
  scanned_tasks bigint NOT NULL DEFAULT 0 CHECK (scanned_tasks >= 0),
  indexed_tasks bigint NOT NULL DEFAULT 0 CHECK (indexed_tasks >= 0),
  validation jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code text,
  CHECK ((status = 'building') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS redis_index_generations_active_idx
  ON redis_index_generations(status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS redis_index_generations_building_idx
  ON redis_index_generations(status) WHERE status = 'building';

CREATE TABLE IF NOT EXISTS redis_index_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_generation_id text REFERENCES redis_index_generations(id),
  scheduler_mode text NOT NULL CHECK (scheduler_mode IN ('ready', 'queue_rebuilding')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO redis_index_state (singleton, active_generation_id, scheduler_mode)
VALUES (true, NULL, 'queue_rebuilding') ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION astra_seed_event_deliveries() RETURNS trigger AS $$
BEGIN
  INSERT INTO event_relay_deliveries (event_id, sink, status)
  VALUES (NEW.id, 'kafka', 'pending'), (NEW.id, 'redis', 'pending')
  ON CONFLICT (event_id, sink) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outbox_seed_event_deliveries ON outbox_events;
CREATE TRIGGER outbox_seed_event_deliveries AFTER INSERT ON outbox_events
FOR EACH ROW EXECUTE FUNCTION astra_seed_event_deliveries();

INSERT INTO event_relay_deliveries (event_id, sink, status, delivered_at, updated_at)
SELECT o.id, sink.name,
  CASE WHEN o.published_at IS NULL THEN 'pending' ELSE 'delivered' END,
  o.published_at, now()
FROM outbox_events o CROSS JOIN (VALUES ('kafka'), ('redis')) AS sink(name)
ON CONFLICT (event_id, sink) DO NOTHING;

CREATE OR REPLACE FUNCTION astra_guard_event_receipt_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_event_receipt';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS event_consumer_receipts_append_only ON event_consumer_receipts;
CREATE TRIGGER event_consumer_receipts_append_only BEFORE UPDATE OR DELETE ON event_consumer_receipts
FOR EACH ROW EXECUTE FUNCTION astra_guard_event_receipt_immutable();
