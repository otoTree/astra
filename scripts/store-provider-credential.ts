import { createDatabase, ProviderCredentialRepository, RequestCipher } from "@astra/database";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const database = createDatabase(required("DATABASE_URL"));
try {
  const repository = new ProviderCredentialRepository(
    database.client,
    new RequestCipher(required("PROVIDER_CREDENTIAL_ENCRYPTION_KEY")),
  );
  const stored = await repository.putActive({
    provider: "gongji",
    credentialName: process.env.PROVIDER_CREDENTIAL_NAME ?? "default",
    token: required("GONGJI_TOKEN"),
    createdBy: process.env.PROVIDER_CREDENTIAL_CREATED_BY ?? "credential-bootstrap",
  });
  console.log(
    JSON.stringify({
      event: "provider_credential_stored",
      provider: "gongji",
      credential_id: stored.id,
      version: stored.version,
      token_fingerprint: stored.tokenFingerprint,
    }),
  );
} finally {
  await database.client.end();
}
