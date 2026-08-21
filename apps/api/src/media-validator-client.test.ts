import { describe, expect, test } from "bun:test";
import { MediaValidatorClient, MediaValidatorError } from "./media-validator-client.ts";

const request = {
  file_id: "file_contract",
  object_key: "inputs/project/file_contract",
  content_type: "image/png" as const,
  size_bytes: 68,
  sha256: "0".repeat(64),
};

async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  run: (url: string) => Promise<void>,
) {
  const server = Bun.serve({ port: 0, fetch: handler });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

describe("MediaValidatorClient", () => {
  test("times out with a retryable infrastructure error", async () => {
    await withServer(
      async () => {
        await Bun.sleep(100);
        return Response.json({});
      },
      async (url) => {
        const client = new MediaValidatorClient(url, "service-token", 10);
        try {
          await client.validate(request);
          throw new Error("expected_validation_timeout");
        } catch (error) {
          expect(error).toBeInstanceOf(MediaValidatorError);
          expect(error).toEqual(expect.objectContaining({ kind: "unavailable", retryable: true, status: 503 }));
        }
      },
    );
  });

  test("distinguishes deterministic rejection from service failure", async () => {
    await withServer(
      () => Response.json({ error: { code: "media_decode_failed" } }, { status: 422 }),
      async (url) => {
        const client = new MediaValidatorClient(url, "service-token");
        await expect(client.validate(request)).rejects.toEqual(
          expect.objectContaining({ kind: "rejected", retryable: false, status: 422 }),
        );
      },
    );
    await withServer(
      () => Response.json({ file_id: request.file_id, valid: true, media: {} }),
      async (url) => {
        const client = new MediaValidatorClient(url, "service-token");
        await expect(client.validate(request)).rejects.toEqual(
          expect.objectContaining({ kind: "unavailable", retryable: true, status: 502 }),
        );
      },
    );
  });
});
