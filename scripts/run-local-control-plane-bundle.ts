type ManagedProcess = {
  name: string;
  process: Bun.Subprocess<"ignore", "inherit", "inherit">;
};

const parseEnabled = (name: string): boolean => {
  const value = process.env[name] ?? "false";
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
};

if (process.env.ASTRA_ENV !== "local" && process.env.ASTRA_ENV !== "test") {
  throw new Error("control_plane_bundle_is_local_or_test_only");
}

const runOnce = async (name: string, command: string[]): Promise<void> => {
  const child = Bun.spawn(command, {
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${name}_failed:${exitCode}`);
};

if (parseEnabled("ASTRA_BUNDLE_RUN_MIGRATIONS")) {
  await runOnce("database_migration", ["bun", "run", "packages/database/src/migrate.ts"]);
}
if (parseEnabled("ASTRA_BUNDLE_BOOTSTRAP_IDENTITY")) {
  await runOnce("identity_bootstrap", ["bun", "run", "scripts/bootstrap-local-identity.ts"]);
}
if (parseEnabled("ASTRA_BUNDLE_BOOTSTRAP_WORKER")) {
  await runOnce("worker_bootstrap", ["bun", "run", "scripts/bootstrap-local-worker.ts"]);
}

const commands: ReadonlyArray<readonly [name: string, command: string[]]> = [
  ["control-plane-edge", ["bun", "run", "scripts/control-plane-edge.ts"]],
  ["public-api", ["bun", "run", "apps/api/src/public.ts"]],
  ["admin-api", ["bun", "run", "apps/api/src/admin.ts"]],
  ["worker-control-api", ["bun", "run", "apps/api/src/worker-control.ts"]],
  ["scheduler", ["bun", "run", "apps/scheduler/src/main.ts"]],
  ["provider-controller", ["bun", "run", "apps/provider-controller/src/main.ts"]],
  ["event-relay", ["bun", "run", "apps/event-relay/src/main.ts"]],
  ["file-sweeper", ["bun", "run", "apps/api/src/file-sweeper.ts"]],
];

const children: ManagedProcess[] = commands.map(([name, command]) => ({
  name,
  process: Bun.spawn(command, {
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }),
}));

let stopping = false;
const stop = async (signal: NodeJS.Signals): Promise<void> => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.process.kill(signal);
  await Promise.allSettled(children.map((child) => child.process.exited));
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

const firstExit = await Promise.race(
  children.map(async (child) => ({ name: child.name, exitCode: await child.process.exited })),
);
if (!stopping) {
  console.error(
    JSON.stringify({
      component: "local-control-plane-bundle",
      event: "child_exited",
      service: firstExit.name,
      exit_code: firstExit.exitCode,
    }),
  );
  await stop("SIGTERM");
  process.exit(firstExit.exitCode === 0 ? 1 : firstExit.exitCode);
}
