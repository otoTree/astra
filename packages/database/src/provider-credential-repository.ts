import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { RequestCipher } from "./request-cipher.ts";

type SqlClient = ReturnType<typeof postgres>;

export type ProviderCredentialMetadata = Readonly<{
  id: string;
  provider: string;
  credentialName: string;
  tokenCiphertext: string;
  tokenFingerprint: string;
  version: number;
  status: "active" | "revoked";
}>;

export class ProviderCredentialRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly cipher: RequestCipher,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () => `provider_credential_${Bun.randomUUIDv7()}`,
  ) {}

  async active(provider: string, credentialName = "default"): Promise<ProviderCredentialMetadata | undefined> {
    const rows = await this.sql`SELECT id, provider, credential_name, token_ciphertext,
      token_fingerprint, version, status FROM provider_credentials
      WHERE provider=${provider} AND credential_name=${credentialName} AND status='active'
      ORDER BY version DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: String(row.id),
      provider: String(row.provider),
      credentialName: String(row.credential_name),
      tokenCiphertext: String(row.token_ciphertext),
      tokenFingerprint: String(row.token_fingerprint),
      version: Number(row.version),
      status: "active",
    };
  }

  openToken(credential: ProviderCredentialMetadata): string {
    const token = this.cipher.open<unknown>(credential.tokenCiphertext);
    if (typeof token !== "string" || token.length === 0) throw new Error("provider_credential_invalid");
    return token;
  }

  async putActive(input: Readonly<{ provider: string; credentialName?: string; token: string; createdBy?: string }>) {
    if (!input.token || input.token.length > 4096) throw new Error("provider_credential_invalid");
    const credentialName = input.credentialName ?? "default";
    const fingerprint = createHash("sha256").update(input.token).digest("hex");
    const ciphertext = this.cipher.seal(input.token);
    const timestamp = this.now().toISOString();
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`provider-credential:${input.provider}:${credentialName}`}))`;
      const current = await transaction`SELECT version FROM provider_credentials
        WHERE provider=${input.provider} AND credential_name=${credentialName} AND status='active'
        FOR UPDATE`;
      const version = Number(current[0]?.version ?? 0) + 1;
      await transaction`UPDATE provider_credentials SET status='revoked', revoked_at=${timestamp}, updated_at=${timestamp}
        WHERE provider=${input.provider} AND credential_name=${credentialName} AND status='active'`;
      const id = this.createId();
      await transaction`INSERT INTO provider_credentials (
        id, provider, credential_name, token_ciphertext, token_fingerprint, version, status,
        created_by, created_at, updated_at, rotated_at
      ) VALUES (
        ${id}, ${input.provider}, ${credentialName}, ${ciphertext}, ${fingerprint}, ${version}, 'active',
        ${input.createdBy ?? null}, ${timestamp}, ${timestamp}, ${version > 1 ? timestamp : null}
      )`;
      return { id, version, tokenFingerprint: fingerprint };
    });
  }
}
