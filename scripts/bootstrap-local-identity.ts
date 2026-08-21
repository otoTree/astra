import { publicApiScopes } from "@astra/auth";
import { createDatabase, IdentityRepository } from "@astra/database";

if (process.env.ASTRA_ENV !== "local") throw new Error("local_identity_bootstrap_requires_local_environment");
const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.ASTRA_LOCAL_API_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!apiKey) throw new Error("ASTRA_LOCAL_API_KEY is required");
const match = apiKey.match(/^astra_sk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/);
if (!match?.[1]) throw new Error("ASTRA_LOCAL_API_KEY has an invalid format");

const database = createDatabase(databaseUrl);
const identities = new IdentityRepository(database.client);
const localScopes = publicApiScopes.filter((scope) => scope !== "tasks:read_sensitive");
try {
  const existing = await identities.findApiKeyByPrefix(match[1]);
  if (existing) {
    if (!(await Bun.password.verify(apiKey, existing.secretHash, "argon2id"))) {
      throw new Error("local_api_key_prefix_conflict");
    }
    if (existing.status !== "active") throw new Error("local_api_key_is_revoked");
    await database.client`UPDATE api_keys SET scopes=${database.client.array(localScopes)}, updated_at=now()
      WHERE id=${existing.id}`;
    console.log(JSON.stringify({ event: "local_identity_verified", api_key_id: existing.id }));
  } else {
    const secretHash = await Bun.password.hash(apiKey, {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    });
    await identities.createApiKey({
      id: "key_local_primary",
      organizationId: "org_local",
      defaultProjectId: "project_local",
      name: "Local Development",
      keyPrefix: match[1],
      keyLastFour: apiKey.slice(-4),
      secretHash,
      scopes: localScopes,
      projectIds: ["project_local"],
      createdAt: new Date(),
    });
    console.log(JSON.stringify({ event: "local_identity_created", api_key_id: "key_local_primary" }));
  }
} finally {
  await database.client.end();
}
