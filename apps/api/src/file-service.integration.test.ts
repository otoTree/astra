import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createDatabase, FileRepository } from "@astra/database";
import { FileService } from "./file-service.ts";
import { MediaValidatorClient } from "./media-validator-client.ts";

const databaseUrl = process.env.ASTRA_TEST_DATABASE_URL;
const endpoint = process.env.ASTRA_TEST_S3_ENDPOINT;
const publicEndpoint = process.env.ASTRA_TEST_S3_PUBLIC_ENDPOINT;
const bucket = process.env.ASTRA_TEST_S3_BUCKET;
const accessKey = process.env.ASTRA_TEST_S3_ACCESS_KEY;
const secretKey = process.env.ASTRA_TEST_S3_SECRET_KEY;
const validatorUrl = process.env.ASTRA_TEST_MEDIA_VALIDATOR_URL;
const validatorToken = process.env.ASTRA_TEST_MEDIA_VALIDATOR_TOKEN;
const enabled = Boolean(
  databaseUrl && endpoint && publicEndpoint && bucket && accessKey && secretKey && validatorUrl && validatorToken,
);
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
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function requireDependencies() {
  if (
    !database ||
    !storage ||
    !endpoint ||
    !publicEndpoint ||
    !bucket ||
    !accessKey ||
    !secretKey ||
    !validatorUrl ||
    !validatorToken
  ) {
    throw new Error("S3 integration configuration unavailable");
  }
  const repository = new FileRepository(database.client);
  return {
    database,
    storage,
    bucket,
    repository,
    service: new FileService(
      repository,
      { endpoint, publicEndpoint, bucket, accessKey, secretKey },
      new MediaValidatorClient(validatorUrl, validatorToken),
    ),
  };
}

async function reserve(
  service: FileService,
  repository: FileRepository,
  filename: string,
  contentType: "image/png" | "video/mp4",
  bytes: Uint8Array,
  sha256 = createHash("sha256").update(bytes).digest("hex"),
) {
  const reservation = await service.reserve("project_s3_contract", {
    filename,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256,
    purpose: "generation_input",
  });
  const file = await repository.get("project_s3_contract", String(reservation.id));
  if (!file) throw new Error("reserved file unavailable");
  createdFiles.push({ id: file.id, objectKey: file.objectKey });
  return { reservation, file, sha256 };
}

async function expectObjectMissing(storageClient: S3Client, storageBucket: string, objectKey: string): Promise<void> {
  try {
    await storageClient.send(new HeadObjectCommand({ Bucket: storageBucket, Key: objectKey }));
    throw new Error("expected_object_to_be_missing");
  } catch (error) {
    if (error instanceof Error && error.message === "expected_object_to_be_missing") throw error;
    expect(error).toBeDefined();
  }
}

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
    const { repository, service } = requireDependencies();
    const bytes = await Bun.file("model-workers/reference/fixtures/sample.mp4").bytes();
    const { reservation, file, sha256 } = await reserve(service, repository, "sample.mp4", "video/mp4", bytes);
    const upload = reservation.upload as { url: string; headers: Record<string, string> };
    const uploadResponse = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes });
    expect(uploadResponse.status).toBe(200);

    const fileId = String(reservation.id);
    const available = await service.complete("project_s3_contract", fileId);
    expect(available).toEqual(
      expect.objectContaining({
        id: fileId,
        status: "available",
        sha256,
        media: expect.objectContaining({ media_type: "video", width: 320, height: 180 }),
      }),
    );
    expect(await service.complete("project_s3_contract", fileId)).toEqual(available);
    expect(await service.get("project_s3_contract", fileId)).toEqual(available);

    const contentResponse = await fetch(await service.contentUrl("project_s3_contract", fileId));
    expect(contentResponse.status).toBe(200);
    expect(Buffer.from(await contentResponse.arrayBuffer())).toEqual(Buffer.from(bytes));
    expect(file.objectKey).toContain(fileId);
  });

  integrationTest("accepts a strictly decodable PNG", async () => {
    const { repository, service } = requireDependencies();
    const { reservation } = await reserve(service, repository, "pixel.png", "image/png", pngBytes);
    const upload = reservation.upload as { url: string; headers: Record<string, string> };
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: pngBytes })).status).toBe(200);
    const available = await service.complete("project_s3_contract", String(reservation.id));
    expect(available).toEqual(
      expect.objectContaining({
        status: "available",
        media: expect.objectContaining({ media_type: "image", width: 1, height: 1 }),
      }),
    );
  });

  integrationTest("rejects MIME mismatch and removes the untrusted object", async () => {
    const { repository, service, storage: storageClient, bucket: storageBucket } = requireDependencies();
    const bytes = await Bun.file("model-workers/reference/fixtures/sample.mp4").bytes();
    const { file, sha256 } = await reserve(service, repository, "wrong.png", "image/png", bytes);
    await storageClient.send(
      new PutObjectCommand({
        Bucket: storageBucket,
        Key: file.objectKey,
        Body: bytes,
        ContentType: "image/png",
        Metadata: { sha256 },
      }),
    );
    await expect(service.complete("project_s3_contract", file.id)).rejects.toThrow("media_validation_failed");
    expect((await repository.get("project_s3_contract", file.id))?.status).toBe("rejected");
    await expectObjectMissing(storageClient, storageBucket, file.objectKey);
  });

  integrationTest("rejects corrupt media and hash mismatch", async () => {
    const { repository, service, storage: storageClient, bucket: storageBucket } = requireDependencies();
    const corrupt = Buffer.alloc(32);
    corrupt.write("ftyp", 4, "ascii");
    const corruptReservation = await reserve(service, repository, "corrupt.mp4", "video/mp4", corrupt);
    await storageClient.send(
      new PutObjectCommand({
        Bucket: storageBucket,
        Key: corruptReservation.file.objectKey,
        Body: corrupt,
        ContentType: "video/mp4",
        Metadata: { sha256: corruptReservation.sha256 },
      }),
    );
    await expect(service.complete("project_s3_contract", corruptReservation.file.id)).rejects.toThrow(
      "media_validation_failed",
    );
    await expectObjectMissing(storageClient, storageBucket, corruptReservation.file.objectKey);

    const expectedHash = "a".repeat(64);
    const hashReservation = await reserve(service, repository, "hash.png", "image/png", pngBytes, expectedHash);
    await storageClient.send(
      new PutObjectCommand({
        Bucket: storageBucket,
        Key: hashReservation.file.objectKey,
        Body: pngBytes,
        ContentType: "image/png",
        Metadata: { sha256: expectedHash },
      }),
    );
    await expect(service.complete("project_s3_contract", hashReservation.file.id)).rejects.toThrow(
      "media_validation_failed",
    );
    expect((await repository.get("project_s3_contract", hashReservation.file.id))?.status).toBe("rejected");
    await expectObjectMissing(storageClient, storageBucket, hashReservation.file.objectKey);
  });

  integrationTest("preserves media for retry when service authentication fails", async () => {
    const dependencies = requireDependencies();
    if (!endpoint || !publicEndpoint || !accessKey || !secretKey || !validatorUrl) {
      throw new Error("S3 integration configuration unavailable");
    }
    const service = new FileService(
      dependencies.repository,
      { endpoint, publicEndpoint, bucket: dependencies.bucket, accessKey, secretKey },
      new MediaValidatorClient(validatorUrl, "incorrect-media-validator-token-value"),
    );
    const reservation = await reserve(service, dependencies.repository, "retry.png", "image/png", pngBytes);
    const upload = reservation.reservation.upload as { url: string; headers: Record<string, string> };
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: pngBytes })).status).toBe(200);
    await expect(service.complete("project_s3_contract", reservation.file.id)).rejects.toThrow(
      "media_validator_unavailable",
    );
    expect((await dependencies.repository.get("project_s3_contract", reservation.file.id))?.status).toBe("validating");
    expect(
      await dependencies.storage.send(
        new HeadObjectCommand({ Bucket: dependencies.bucket, Key: reservation.file.objectKey }),
      ),
    ).toBeDefined();
  });

  integrationTest("expires abandoned uploads and rejects HEAD metadata mismatch", async () => {
    const dependencies = requireDependencies();
    if (!endpoint || !publicEndpoint || !accessKey || !secretKey || !validatorUrl || !validatorToken) {
      throw new Error("S3 integration configuration unavailable");
    }
    let clock = new Date();
    const service = new FileService(
      dependencies.repository,
      { endpoint, publicEndpoint, bucket: dependencies.bucket, accessKey, secretKey, now: () => new Date(clock) },
      new MediaValidatorClient(validatorUrl, validatorToken),
    );
    const abandoned = await reserve(service, dependencies.repository, "abandoned.png", "image/png", pngBytes);
    clock = new Date(clock.getTime() + 16 * 60 * 1000);
    await expect(service.complete("project_s3_contract", abandoned.file.id)).rejects.toThrow("upload_expired");

    const mismatch = await reserve(service, dependencies.repository, "length.png", "image/png", pngBytes);
    const truncated = pngBytes.subarray(0, pngBytes.byteLength - 1);
    await dependencies.storage.send(
      new PutObjectCommand({
        Bucket: dependencies.bucket,
        Key: mismatch.file.objectKey,
        Body: truncated,
        ContentType: "image/png",
        Metadata: { sha256: mismatch.sha256 },
      }),
    );
    await expect(service.complete("project_s3_contract", mismatch.file.id)).rejects.toThrow(
      "upload_integrity_mismatch",
    );
    expect((await dependencies.repository.get("project_s3_contract", mismatch.file.id))?.status).toBe("rejected");
    await expectObjectMissing(dependencies.storage, dependencies.bucket, mismatch.file.objectKey);
  });
});
