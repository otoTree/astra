import { createHash } from "node:crypto";

const sensitiveKey =
  /(?:token|secret|password|authorization|private[_-]?key|repository_account|repository_password|url)$/i;

export const redactProviderPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactProviderPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactProviderPayload(item),
    ]),
  );
};

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const payloadSha256 = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
