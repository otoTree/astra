import { createHmac } from "node:crypto";
import { createDatabase } from "@astra/database";

if (process.env.ASTRA_ENV === "production") throw new Error("local_worker_bootstrap_forbidden_in_production");
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`local_worker_bootstrap_missing:${name}`);
  return value;
};

const database = createDatabase(required("DATABASE_URL"));
const token = required("WORKER_BOOTSTRAP_TOKEN");
const pepper = required("WORKER_TOKEN_PEPPER");
const replicaId = process.env.WORKER_REPLICA_ID ?? "replica_local_reference";
const providerResourceId = process.env.WORKER_PROVIDER_INSTANCE_ID ?? "instance_local_reference";
const timestamp = new Date();
const tokenHash = createHmac("sha256", pepper).update(token).digest("hex");

try {
  await database.client.begin(async (transaction) => {
    await transaction`UPDATE model_pools SET status='active', updated_at=${timestamp.toISOString()}
      WHERE id='pool_local_reference'`;
    await transaction`UPDATE model_releases SET accept_new_tasks=true WHERE id='release_local_reference'`;
    await transaction`INSERT INTO replicas (
      id, pool_id, release_id, provider, provider_resource_id, region_id, gpu_sku, image_digest,
      desired_state, observed_state, rollout_reserved, version, last_observed_at, created_at, updated_at
    ) VALUES (
      ${replicaId}, 'pool_local_reference', 'release_local_reference', 'reference', ${providerResourceId},
      'region_local', 'reference-gpu', 'sha256:local-reference', 'ready', 'provisioning', false, 0,
      ${timestamp.toISOString()}, ${timestamp.toISOString()}, ${timestamp.toISOString()}
    ) ON CONFLICT (id) DO UPDATE SET provider_resource_id=EXCLUDED.provider_resource_id,
      desired_state='ready', observed_state=CASE WHEN replicas.observed_state IN ('ready', 'busy')
        THEN replicas.observed_state ELSE 'provisioning' END, updated_at=EXCLUDED.updated_at`;
    await transaction`INSERT INTO worker_bootstrap_tokens (
      id, token_hash, replica_id, release_id, expires_at, created_at
    ) VALUES (
      ${`bootstrap_${Bun.randomUUIDv7()}`}, ${tokenHash}, ${replicaId}, 'release_local_reference',
      ${new Date(timestamp.getTime() + 24 * 60 * 60 * 1000).toISOString()}, ${timestamp.toISOString()}
    ) ON CONFLICT (token_hash) DO UPDATE SET replica_id=EXCLUDED.replica_id,
      release_id=EXCLUDED.release_id, expires_at=EXCLUDED.expires_at, used_at=NULL`;
  });
  console.log(JSON.stringify({ event: "local_worker_bootstrap_ready", replica_id: replicaId }));
} finally {
  await database.client.end();
}
