import { createClient, createCluster } from "redis";

export type RedisDeploymentMode = "cluster" | "standalone";

export interface RedisTransaction {
  hSet(key: string, field: string, value: string): RedisTransaction;
  hDel(key: string, field: string): RedisTransaction;
  zAdd(key: string, member: Readonly<{ score: number; value: string }>): RedisTransaction;
  zRem(key: string, member: string): RedisTransaction;
  del(keys: readonly string[]): RedisTransaction;
  exec(): Promise<unknown>;
}

export interface RedisCommandClient {
  on(event: "error", listener: (error: Error) => void): unknown;
  connect(): Promise<unknown>;
  close(): Promise<void>;
  ping(): Promise<string>;
  eval(script: string, options: Readonly<{ keys: string[]; arguments: string[] }>): Promise<unknown>;
  multi(): RedisTransaction;
  sAdd(key: string, member: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  hLen(key: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | undefined>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  del(keys: string | readonly string[]): Promise<number>;
  xAdd(
    key: string,
    id: string,
    message: Readonly<Record<string, string>>,
    options: Readonly<{
      TRIM: Readonly<{ strategy: "MAXLEN"; strategyModifier: "~"; threshold: number }>;
    }>,
  ): Promise<string>;
  xTrim(
    key: string,
    strategy: "MINID",
    threshold: string,
    options: Readonly<{ strategyModifier: "~" }>,
  ): Promise<number>;
  xLen(key: string): Promise<number>;
}

export const createRedisCommandClient = (url: string, mode: RedisDeploymentMode): RedisCommandClient => {
  const client = mode === "cluster" ? createCluster({ rootNodes: [{ url }] }) : createClient({ url });
  client.on("error", () => undefined);
  return client as unknown as RedisCommandClient;
};
