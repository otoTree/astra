import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FileUploadRequest } from "@astra/contracts";
import type { FileRecord, FileRepository } from "@astra/database";

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
});

export class FileService {
  private readonly storage: S3Client;
  private readonly signer: S3Client;
  private readonly now: () => Date;

  constructor(
    private readonly repository: FileRepository,
    private readonly options: FileServiceOptions,
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

  async reserve(projectId: string, input: FileUploadRequest): Promise<Record<string, unknown>> {
    const file = await this.repository.createPending(projectId, input, this.now());
    const checksum = Buffer.from(input.sha256, "hex").toString("base64");
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: file.objectKey,
      ContentType: input.content_type,
      ContentLength: input.size_bytes,
      ChecksumSHA256: checksum,
      Metadata: { sha256: input.sha256 },
    });
    const url = await getSignedUrl(this.signer, command, { expiresIn: 15 * 60 });
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
    if (file.status !== "pending_upload" && file.status !== "available") throw new Error("invalid_file_state");
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
    const available = await this.repository.markAvailable(projectId, fileId, this.now());
    if (!available) throw new Error("invalid_file_state");
    return view(available);
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
