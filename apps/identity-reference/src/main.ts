import { createSign, generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

if (process.env.ASTRA_ENV !== "local") throw new Error("identity_reference_requires_local_environment");

const port = z.coerce.number().int().min(1).max(65535).default(4180).parse(process.env.IDENTITY_REFERENCE_PORT);
const issuer = z
  .string()
  .url()
  .parse(process.env.IDENTITY_REFERENCE_ISSUER ?? "http://identity-reference:4180");
const audience = z
  .string()
  .min(1)
  .parse(process.env.IDENTITY_REFERENCE_AUDIENCE ?? "astra-admin");
const keyId = `local-${Bun.randomUUIDv7()}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });

const tokenRequestSchema = z
  .object({
    subject: z.string().min(1).max(256).default("local-operator"),
    groups: z.array(z.string().min(1).max(256)).max(100).default(["astra-local-admins"]),
    email: z.string().email().default("operator@astra.local"),
    name: z.string().min(1).max(500).default("Astra Local Operator"),
    expires_in: z.number().int().min(60).max(3600).default(900),
  })
  .strict();

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const app = new Hono();
app.get("/health/ready", (context) => context.json({ status: "ready" }));
app.get("/.well-known/openid-configuration", (context) =>
  context.json({
    issuer,
    jwks_uri: `${issuer}/jwks`,
    id_token_signing_alg_values_supported: ["RS256"],
  }),
);
app.get("/jwks", (context) =>
  context.json({
    keys: [{ ...publicJwk, kid: keyId, use: "sig", alg: "RS256" }],
  }),
);
app.post("/v1/id-tokens", async (context) => {
  const body: unknown = await context.req.json().catch(() => undefined);
  const parsed = tokenRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return context.json({ error: { code: "invalid_token_request" } }, 422);
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT", kid: keyId });
  const payload = encode({
    iss: issuer,
    sub: parsed.data.subject,
    aud: audience,
    iat: issuedAt,
    nbf: issuedAt - 1,
    exp: issuedAt + parsed.data.expires_in,
    jti: `oidc_${Bun.randomUUIDv7()}`,
    groups: parsed.data.groups,
    email: parsed.data.email,
    email_verified: true,
    name: parsed.data.name,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  context.header("Cache-Control", "no-store");
  return context.json({
    id_token: `${header}.${payload}.${signature}`,
    token_type: "Bearer",
    expires_in: parsed.data.expires_in,
  });
});

Bun.serve({ port, fetch: app.fetch });
console.log(JSON.stringify({ level: "info", event: "identity_reference_started", port, issuer }));
