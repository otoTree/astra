-- Replace the legacy Kafka delivery with Redis Streams. Existing Outbox rows are
-- replayed to Redis Streams; PostgreSQL remains the source of truth.
ALTER TABLE event_relay_deliveries DROP CONSTRAINT IF EXISTS event_relay_deliveries_sink_check;
DELETE FROM event_relay_deliveries WHERE sink = 'kafka';
ALTER TABLE event_relay_deliveries ADD CONSTRAINT event_relay_deliveries_sink_check
  CHECK (sink IN ('redis_streams', 'redis'));
ALTER TABLE event_dead_letters DROP CONSTRAINT IF EXISTS event_dead_letters_sink_check;
ALTER TABLE event_dead_letters ADD CONSTRAINT event_dead_letters_sink_check
  CHECK (sink IN ('redis_streams', 'redis', 'kafka'));

INSERT INTO event_relay_deliveries (event_id, sink, status, updated_at)
SELECT o.id, 'redis_streams', 'pending', now()
FROM outbox_events o
ON CONFLICT (event_id, sink) DO NOTHING;

CREATE OR REPLACE FUNCTION astra_seed_event_deliveries() RETURNS trigger AS $$
BEGIN
  INSERT INTO event_relay_deliveries (event_id, sink, status)
  VALUES (NEW.id, 'redis_streams', 'pending'), (NEW.id, 'redis', 'pending')
  ON CONFLICT (event_id, sink) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS provider_credentials (
  id text PRIMARY KEY,
  provider text NOT NULL,
  credential_name text NOT NULL,
  token_ciphertext text NOT NULL,
  token_fingerprint text NOT NULL CHECK (token_fingerprint ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (provider, credential_name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_credentials_active_idx
  ON provider_credentials(provider, credential_name) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS provider_credentials_lookup_idx
  ON provider_credentials(provider, credential_name, status, version DESC);

CREATE OR REPLACE FUNCTION astra_guard_provider_credential_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.provider <> OLD.provider OR NEW.credential_name <> OLD.credential_name
    OR NEW.version < OLD.version OR NEW.token_fingerprint <> OLD.token_fingerprint THEN
    RAISE EXCEPTION 'provider_credential_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS provider_credential_identity_guard ON provider_credentials;
CREATE TRIGGER provider_credential_identity_guard BEFORE UPDATE ON provider_credentials
FOR EACH ROW EXECUTE FUNCTION astra_guard_provider_credential_immutable();
