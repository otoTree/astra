import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createDatabase, FileRepository } from "@astra/database";
import { FileService } from "./file-service.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const endpoint = process.env.ASTRA_TEST_S3_ENDPOINT;
const publicEndpoint = process.env.ASTRA_TEST_S3_PUBLIC_ENDPOINT;
const bucket = process.env.ASTRA_TEST_S3_BUCKET;
const accessKey = process.env.ASTRA_TEST_S3_ACCESS_KEY;
const secretKey = process.env.ASTRA_TEST_S3_SECRET_KEY;
const enabled = Boolean(databaseUrl && endpoint && publicEndpoint && bucket && accessKey && secretKey);
const integrationTest = enabled ? test : test.skip;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const storage =
  endpoint && accessKey && secretKey
    ? new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      })
    : undefined;
const createdFiles: Array<{ id: string; objectKey: string }> = [];

beforeAll(async () => {
  if (!database) return;
  await database.client`DELETE FROM files WHERE project_id='project_s3_contract'`;
});

afterAll(async () => {
  if (storage && bucket) {
    await Promise.all(
      createdFiles.map((file) => storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.objectKey }))),
    );
  }
  if (database) {
    await database.client`DELETE FROM files WHERE project_id='project_s3_contract'`;
    await database.client.end();
  }
});

describe("FileService S3 contract", () => {
  integrationTest("uploads, confirms and downloads the exact bytes", async () => {
    if (!database || !endpoint || !publicEndpoint || !bucket || !accessKey || !secretKey) {
      throw new Error("S3 integration configuration unavailable");
    }
    const repository = new FileRepository(database.client);
    const service = new FileService(repository, { endpoint, publicEndpoint, bucket, accessKey, secretKey });
    const bytes = await Bun.file("model-workers/reference/fixtures/sample.mp4").bytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reservation = await service.reserve("project_s3_contract", {
      filename: "sample.mp4",
      content_type: "video/mp4",
      size_bytes: bytes.byteLength,
      sha256,
      purpose: "generation_input",
    });
    const upload = reservation.upload as { url: string; headers: Record<string, string> };
    const uploadResponse = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes });
    expect(uploadResponse.status).toBe(200);

    const fileId = String(reservation.id);
    const file = await repository.get("project_s3_contract", fileId);
    if (!file) throw new Error("reserved file unavailable");
    createdFiles.push({ id: file.id, objectKey: file.objectKey });
    const available = await service.complete("project_s3_contract", fileId);
    expect(available).toEqual(expect.objectContaining({ id: fileId, status: "available", sha256 }));

    const contentResponse = await fetch(await service.contentUrl("project_s3_contract", fileId));
    expect(contentResponse.status).toBe(200);
    expect(Buffer.from(await contentResponse.arrayBuffer())).toEqual(Buffer.from(bytes));
  });
});
