-- Phase 10 HA lease for rollout reconciliation.

ALTER TABLE model_rollouts ADD COLUMN controller_lease_owner text;
ALTER TABLE model_rollouts ADD COLUMN controller_lease_expires_at timestamptz;
ALTER TABLE model_rollouts ADD CONSTRAINT model_rollouts_controller_lease_v1_check CHECK (
  (controller_lease_owner IS NULL AND controller_lease_expires_at IS NULL)
  OR (controller_lease_owner IS NOT NULL AND controller_lease_expires_at IS NOT NULL)
);
CREATE INDEX model_rollouts_controller_claim_v1_idx
  ON model_rollouts(status, controller_lease_expires_at, created_at, id)
  WHERE status IN ('pending','validating','rolling','rolling_back');
