type RuntimeConfig = Readonly<{ ADMIN_API_PUBLIC_URL?: string }>;

declare global {
  interface Window {
    __ASTRA_CONFIG__?: RuntimeConfig;
  }
}

const csrfStorageKey = "astra_admin_csrf_token";

export const adminApiRequestUrl = (
  path: string,
  publicUrl = typeof window === "undefined" ? undefined : window.__ASTRA_CONFIG__?.ADMIN_API_PUBLIC_URL,
): string => {
  if (!path.startsWith("/admin/v1/")) throw new Error("invalid_admin_api_path");
  return publicUrl ? `${publicUrl}${path}` : path;
};

export const saveCsrfToken = (token: string, storage: Pick<Storage, "setItem"> = window.sessionStorage): void =>
  storage.setItem(csrfStorageKey, token);

export const readCsrfToken = (storage: Pick<Storage, "getItem"> = window.sessionStorage): string =>
  storage.getItem(csrfStorageKey) ?? "";

export const api = async <T>(path: string): Promise<T> => {
  const response = await fetch(adminApiRequestUrl(path), {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(response.status === 401 ? "session_required" : `request_failed:${response.status}`);
  return (await response.json()) as T;
};

export const mutate = async <T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  idempotencyKey: string,
  version?: number,
): Promise<T> => {
  const response = await fetch(adminApiRequestUrl(path), {
    method,
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-csrf-token": readCsrfToken(),
      ...(version === undefined ? {} : { "if-match": `"${version}"` }),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: { code?: string } };
  if (!response.ok) throw new Error(payload.error?.code ?? `request_failed:${response.status}`);
  return payload;
};
