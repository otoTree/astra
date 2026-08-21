import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const stateSchema = z
  .object({
    worker_id: z.string().min(1),
    token: z.string().min(32),
    token_expires_at: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
  })
  .strict();
export type WorkerAgentState = z.infer<typeof stateSchema>;

export class WorkerStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<WorkerAgentState | undefined> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: WorkerAgentState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${Bun.randomUUIDv7()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
