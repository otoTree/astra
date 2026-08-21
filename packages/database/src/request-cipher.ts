import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class RequestCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  open<T>(sealed: string): T {
    const [version, ivValue, tagValue, ciphertextValue] = sealed.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) throw new Error("request_decryption_failed");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8"),
    ) as T;
  }
}
