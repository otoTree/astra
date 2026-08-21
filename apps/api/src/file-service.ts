import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mediaValidationRequestSchema, type FileUploadRequest, type MediaMetadata } from "@astra/contracts";
import type { FileAdmissionContext, FileRecord, FileRepository } from "@astra/database";
import { MediaValidatorError, type MediaValidator } from "./media-validator-client.ts";

export type FileServiceOptions = Readonly<{
  endpoint: string;
  publicEndpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  now?: () => Date;
}>;

const unix = (value: Date | string): number => Math.floor(new Date(value).getTime() / 1000);
const view = (file: FileRecord) => ({
  id: file.id,
  object: "file",
  status: file.status,
  filename: file.filename,
  content_type: file.contentType,
  size_bytes: file.sizeBytes,
  sha256: file.sha256,
  purpose: file.purpose,
  created_at: unix(file.createdAt),
  expires_at: unix(file.expiresAt),
  media: file.media,
});

export class FileService {
  private readonly storage: S3Client;
  private readonly signer: S3Client;
  private readonly now: () => Date;

  constructor(
    private readonly repository: FileRepository,
    private readonly options: FileServiceOptions,
    private readonly validator: MediaValidator,
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

  async reserve(context: FileAdmissionContext, input: FileUploadRequest): Promise<Record<string, unknown>> {
    const file = await this.repository.createPendingAuthorized(context, input, this.now());
    const checksum = Buffer.from(input.sha256, "hex").toString("base64");
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: file.objectKey,
      ContentType: input.content_type,
      ContentLength: input.size_bytes,
      ChecksumSHA256: checksum,
      Metadata: { sha256: input.sha256 },
    });
    let url: string;
    try {
      url = await getSignedUrl(this.signer, command, { expiresIn: 15 * 60 });
    } catch (error) {
      await this.repository.abortPending(context.projectId, file.id, this.now());
      throw error;
    }
    return {
      id: file.id,
      object: "file.upload",
      status: file.status,
      upload: {
        method: "PUT",
        url,
        headers: {
          "content-type": input.content_type,
          "content-length": String(input.size_bytes),
        },
        expires_at: unix(file.expiresAt),
      },
      created_at: unix(file.createdAt),
    };
  }

  async complete(projectId: string, fileId: string): Promise<Record<string, unknown>> {
    const file = await this.repository.get(projectId, fileId);
    if (!file) throw new Error("file_not_found");
    if (file.status === "rejected") throw new Error("upload_integrity_mismatch");
    if (file.status === "available") return view(file);
    if (file.status !== "pending_upload" && file.status !== "validating") throw new Error("invalid_file_state");
    if (file.status === "pending_upload" && new Date(file.expiresAt) < this.now()) throw new Error("upload_expired");
    let head: HeadObjectOutput;
    try {
      head = await this.storage.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: file.objectKey }));
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NotFound" || name === "NoSuchKey") throw new Error("upload_not_found");
      throw error;
    }
    const checksum = Buffer.from(file.sha256, "hex").toString("base64");
    const valid =
      head.ContentLength === file.sizeBytes &&
      head.ContentType === file.contentType &&
      (head.ChecksumSHA256 === checksum || head.Metadata?.sha256 === file.sha256);
    if (!valid) {
      await this.storage.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: file.objectKey }));
      await this.repository.markRejected(projectId, fileId);
      throw new Error("upload_integrity_mismatch");
    }
    const validating = await this.repository.markValidating(projectId, fileId, this.now());
    if (!validating) throw new Error("invalid_file_state");
    let media: MediaMetadata;
    try {
      const validationRequest = mediaValidationRequestSchema.parse({
        file_id: file.id,
        object_key: file.objectKey,
        content_type: file.contentType,
        size_bytes: file.sizeBytes,
        sha256: file.sha256,
      });
      media = await this.validator.validate(validationRequest);
    } catch (error) {
      if (error instanceof MediaValidatorError && error.kind === "rejected") {
        await this.storage.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: file.objectKey }));
        await this.repository.markRejected(projectId, fileId, this.now());
      }
      throw error;
    }
    const available = await this.repository.markAvailable(projectId, fileId, media, this.now());
    if (!available) throw new Error("invalid_file_state");
    return view(available);
  }

  async get(projectId: string, fileId: string): Promise<Record<string, unknown> | undefined> {
    const file = await this.repository.get(projectId, fileId);
    return file ? view(file) : undefined;
  }

  async contentUrl(projectId: string, fileId: string): Promise<string> {
    const file = await this.repository.get(projectId, fileId);
    if (!file) throw new Error("file_not_found");
    if (file.status !== "available" || new Date(file.expiresAt) <= this.now()) throw new Error("asset_expired");
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.options.bucket, Key: file.objectKey }), {
      expiresIn: 5 * 60,
    });
  }
}
