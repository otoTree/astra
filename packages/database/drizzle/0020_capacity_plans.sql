-- Phase 12 immutable capacity decisions, admission explanations and drain timestamps.

ALTER TABLE replicas ADD COLUMN IF NOT EXISTS idle_since timestamptz;
ALTER TABLE replicas ADD COLUMN IF NOT EXISTS ready_at timestamptz;
ALTER TABLE replicas ADD COLUMN IF NOT EXISTS last_scale_action_at timestamptz;

CREATE TABLE capacity_plans (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  pool_id text NOT NULL REFERENCES model_pools(id),
  policy_version_id text REFERENCES policy_versions(id),
  status text NOT NULL CHECK (status IN ('planned', 'applied', 'suppressed', 'admission_control')),
  observed_at timestamptz NOT NULL,
  input_snapshot jsonb NOT NULL,
  result jsonb NOT NULL,
  current_replicas integer NOT NULL CHECK (current_replicas >= 0),
  desired_replicas integer NOT NULL CHECK (desired_replicas >= 0),
  workload_replicas integer NOT NULL CHECK (workload_replicas >= 0),
  queue_slo_replicas integer NOT NULL CHECK (queue_slo_replicas >= 0),
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  benefit_minor bigint NOT NULL CHECK (benefit_minor >= 0),
  net_benefit_minor bigint NOT NULL,
  admission_control boolean NOT NULL DEFAULT false,
  suppression_reason text,
  strategy_version text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (pool_id, observed_at, id)
);
CREATE INDEX capacity_plans_pool_created_idx ON capacity_plans(pool_id, created_at DESC, id DESC);
CREATE INDEX capacity_plans_admission_idx ON capacity_plans(pool_id, admission_control, created_at DESC);

CREATE OR REPLACE FUNCTION astra_guard_capacity_plan_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_capacity_plan';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER capacity_plans_immutable BEFORE UPDATE OR DELETE ON capacity_plans
FOR EACH ROW EXECUTE FUNCTION astra_guard_capacity_plan_immutable();
