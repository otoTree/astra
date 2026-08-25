import { describe, expect, test } from "bun:test";
import { createDatabase, ProviderCredentialRepository, RequestCipher } from "./index.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const integration = database ? test : test.skip;

describe("Provider credential repository", () => {
  integration("stores only ciphertext, rotates active versions and opens the token", async () => {
    if (!database) throw new Error("test_database_unavailable");
    const provider = `gongji-${Bun.randomUUIDv7()}`;
    const repository = new ProviderCredentialRepository(
      database.client,
      new RequestCipher("credential-test-key-32-characters-minimum"),
    );
    const first = await repository.putActive({ provider, token: "token-v1", createdBy: "test" });
    const second = await repository.putActive({ provider, token: "token-v2", createdBy: "test" });
    expect(second.version).toBe(first.version + 1);
    expect(second.tokenFingerprint).not.toBe(first.tokenFingerprint);
    const active = await repository.active(provider);
    expect(active?.tokenCiphertext).not.toContain("token-v2");
    expect(active ? repository.openToken(active) : undefined).toBe("token-v2");
    const rows = await database.client`SELECT status, version FROM provider_credentials WHERE provider=${provider}`;
    expect(rows.map((row) => String(row.status)).sort()).toEqual(["active", "revoked"]);
    await database.client`DELETE FROM provider_credentials WHERE provider=${provider}`;
  });
});

process.on("beforeExit", () => database?.client.end());
