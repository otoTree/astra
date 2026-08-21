import { createHmac, randomBytes } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  completeOutputsResponseSchema,
  drainedWorkerResponseSchema,
  leasedAttemptSchema,
  prepareOutputsResponseSchema,
  workerHeartbeatResponseSchema,
  workerRegistrationResponseSchema,
  type CompleteAttempt,
  type CompleteOutputs,
  type DrainedWorker,
  type FailAttempt,
  type PrepareOutputs,
  type WorkerHeartbeat,
  type WorkerLeaseRequest,
  type WorkerRegistration,
  type MediaMetadata,
} from "@astra/contracts";
import { canonicalHash, type WorkerIdentity, WorkerControlError, type WorkerControlRepository } from "@astra/database";
import type { MediaValidator } from "./media-validator-client.ts";

export type WorkerControlServiceOptions = Readonly<{
  tokenPepper: string;
  sessionTtlSeconds: number;
  tokenRotateBeforeSeconds: number;
  heartbeatIntervalSeconds: number;
  leaseDurationSeconds: number;
  orphanGracePeriodSeconds: number;
  endpoint: string;
  publicEndpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  now?: () => Date;
}>;

const unix = (value: Date | string): number => Math.floor(new Date(value).getTime() / 1000);
const checksumBase64 = (sha256: string): string => Buffer.from(sha256, "hex").toString("base64");

export class WorkerControlService {
  private readonly storage: S3Client;
  private readonly signer: S3Client;
  private readonly now: () => Date;

  constructor(
    private readonly repository: WorkerControlRepository,
    private readonly validator: MediaValidator,
    private readonly options: WorkerControlServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    const base = {
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
    } as const;
    this.storage = new S3Client({ ...base, endpoint: options.endpoint });
    this.signer = new S3Client({ ...base, endpoint: options.publicEndpoint ?? options.endpoint });
  }

  hashToken(token: string): string {
    return createHmac("sha256", this.options.tokenPepper).update(token).digest("hex");
  }

  private token(): string {
    return `worker_${randomBytes(32).toString("base64url")}`;
  }

  private session() {
    const token = this.token();
    return {
      token,
      id: `workersession_${Bun.randomUUIDv7()}`,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(this.now().getTime() + this.options.sessionTtlSeconds * 1000),
    };
  }

  async register(input: WorkerRegistration, bootstrapToken: string) {
    const session = this.session();
    const registered = await this.repository.register(input, this.hashToken(bootstrapToken), session);
    return workerRegistrationResponseSchema.parse({
      worker_id: registered.workerId,
      worker_token: session.token,
      token_expires_at: unix(session.expiresAt),
      heartbeat_interval_seconds: this.options.heartbeatIntervalSeconds,
      lease_duration_seconds: this.options.leaseDurationSeconds,
      orphan_grace_period_seconds: this.options.orphanGracePeriodSeconds,
    });
  }

  async authenticate(token: string, workerId?: string): Promise<WorkerIdentity> {
    return this.repository.authenticate(this.hashToken(token), workerId);
  }

  async lease(identity: WorkerIdentity, input: WorkerLeaseRequest) {
    const material = await this.repository.lease(
      identity,
      input,
      canonicalHash(input),
      this.options.leaseDurationSeconds,
    );
    if (!material) return undefined;
    const inputDownloads = await Promise.all(
      material.inputDownloads.map(async (download) => ({
        file_id: download.fileId,
        url: await getSignedUrl(
          this.signer,
          new GetObjectCommand({ Bucket: this.options.bucket, Key: download.objectKey }),
          { expiresIn: 5 * 60 },
        ),
        headers: {},
        expires_at: Math.floor(this.now().getTime() / 1000) + 5 * 60,
      })),
    );
    return leasedAttemptSchema.parse({
      attempt_id: material.attemptId,
      lease_id: material.leaseId,
      lease_version: material.leaseVersion,
      lease_expires_at: unix(material.leaseExpiresAt),
      execution_key: material.executionKey,
      inference: material.inference,
      input_downloads: inputDownloads,
    });
  }

  async heartbeat(identity: WorkerIdentity, input: WorkerHeartbeat) {
    const response = await this.repository.heartbeat(
      identity,
      input,
      canonicalHash(input),
      this.options.leaseDurationSeconds,
    );
    const expiresAt = new Date(identity.sessionExpiresAt);
    if (expiresAt.getTime() - this.now().getTime() <= this.options.tokenRotateBeforeSeconds * 1000) {
      const next = this.session();
      await this.repository.rotateSession(identity, next);
      return workerHeartbeatResponseSchema.parse({
        ...response,
        worker_token: next.token,
        token_expires_at: unix(next.expiresAt),
      });
    }
    return workerHeartbeatResponseSchema.parse(response);
  }

  async prepareOutputs(identity: WorkerIdentity, attemptId: string, input: PrepareOutputs) {
    const prepared = await this.repository.prepareOutputs(identity, attemptId, input);
    const uploads = await Promise.all(
      prepared.map(async (output) => {
        const checksum = checksumBase64(output.sha256);
        const headers = {
          "content-type": output.contentType,
          "content-length": String(output.sizeBytes),
          "x-amz-checksum-sha256": checksum,
          "x-amz-meta-sha256": output.sha256,
        };
        const url = await getSignedUrl(
          this.signer,
          new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: output.objectKey,
            ContentType: output.contentType,
            ContentLength: output.sizeBytes,
            ChecksumSHA256: checksum,
            Metadata: { sha256: output.sha256 },
          }),
          {
            expiresIn: 15 * 60,
            signableHeaders: new Set(["content-type"]),
            unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-sha256"]),
          },
        );
        return {
          output_index: output.outputIndex,
          file_id: output.fileId,
          method: "PUT" as const,
          url,
          headers,
          expires_at: Math.floor(this.now().getTime() / 1000) + 15 * 60,
        };
      }),
    );
    return prepareOutputsResponseSchema.parse({
      attempt_id: attemptId,
      lease_version: input.lease_version,
      uploads,
    });
  }

  async completeOutputs(identity: WorkerIdentity, attemptId: string, input: CompleteOutputs) {
    const prepared = await this.repository.preparedOutputs(identity, attemptId, input);
    const validatedMedia = new Map<string, MediaMetadata>();
    for (const output of prepared) {
      const head = await this.storage.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: output.objectKey, ChecksumMode: "ENABLED" }),
      );
      const valid =
        head.ContentLength === output.sizeBytes &&
        head.ContentType === output.contentType &&
        (head.ChecksumSHA256 === checksumBase64(output.sha256) || head.Metadata?.sha256 === output.sha256);
      if (!valid) throw new WorkerControlError("output_integrity_mismatch", 422);
      const actualMedia = await this.validator.validate({
        file_id: output.fileId,
        object_key: output.objectKey,
        content_type: output.contentType as Parameters<MediaValidator["validate"]>[0]["content_type"],
        size_bytes: output.sizeBytes,
        sha256: output.sha256,
      });
      validatedMedia.set(output.fileId, actualMedia);
    }
    const committed = await this.repository.commitOutputs(identity, attemptId, input, validatedMedia);
    return completeOutputsResponseSchema.parse({
      attempt_id: attemptId,
      status: "outputs_committed",
      file_ids: committed.fileIds,
      lease_version: committed.leaseVersion,
    });
  }

  async complete(identity: WorkerIdentity, attemptId: string, input: CompleteAttempt) {
    return this.repository.complete(identity, attemptId, input);
  }

  async fail(identity: WorkerIdentity, attemptId: string, input: FailAttempt) {
    return this.repository.fail(identity, attemptId, input);
  }

  async drained(identity: WorkerIdentity, input: DrainedWorker) {
    const reclaimToken = `reclaim_${randomBytes(32).toString("base64url")}`;
    await this.repository.drained(identity, input, canonicalHash(input), this.hashToken(reclaimToken));
    return drainedWorkerResponseSchema.parse({ accepted: true, reclaim_token: reclaimToken });
  }
}
