import { rm } from "node:fs/promises";

const outdir = "dist/control-plane";
await rm(outdir, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [
    "apps/api/src/public.ts",
    "apps/api/src/admin.ts",
    "apps/api/src/worker-control.ts",
    "apps/scheduler/src/main.ts",
    "apps/provider-controller/src/main.ts",
    "apps/event-relay/src/main.ts",
    "apps/worker-agent/src/main.ts",
    "apps/api/src/media-validator.ts",
    "apps/api/src/file-sweeper.ts",
    "model-workers/reference/src/server.ts",
  ],
  outdir,
  target: "bun",
  format: "esm",
  sourcemap: "external",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const web = Bun.spawn(["bun", "run", "--cwd", "apps/admin-web", "build"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await web.exited) !== 0) process.exit(1);
