import { loadSchedulerConfig } from "@astra/config";
import { CapacityPlanRepository, createDatabase, DatabaseHealth, SchedulingRepository } from "@astra/database";
import { Counter, createLogger, createMetricRegistry, Gauge, Histogram, metricResponse } from "@astra/observability";
import { DeterministicScheduler } from "./scheduler.ts";
import { CapacityPlanner } from "./capacity-planner.ts";

const config = loadSchedulerConfig();
const logger = createLogger("scheduler");
const database = createDatabase(config.DATABASE_URL);
const databaseHealth = new DatabaseHealth(database.client);
const repository = new SchedulingRepository(database.client);
const scheduler = new DeterministicScheduler(repository, {
  batchSize: config.SCHEDULER_BATCH_SIZE,
  reservationSeconds: config.SCHEDULER_RESERVATION_SECONDS,
  workerFreshnessSeconds: config.SCHEDULER_WORKER_FRESHNESS_SECONDS,
});
const capacityPlanner = new CapacityPlanner(new CapacityPlanRepository(database.client));
const metrics = createMetricRegistry("scheduler");
const iterations = new Counter({
  name: "astra_scheduler_iterations_total",
  help: "Scheduler iterations by outcome",
  labelNames: ["outcome"] as const,
  registers: [metrics],
});
const reservations = new Counter({
  name: "astra_scheduler_reservations_total",
  help: "Slot reservation outcomes",
  labelNames: ["outcome"] as const,
  registers: [metrics],
});
const candidates = new Gauge({
  name: "astra_scheduler_candidates",
  help: "Candidates observed in the latest authoritative snapshot",
  labelNames: ["kind"] as const,
  registers: [metrics],
});
const queuedGpuSeconds = new Gauge({
  name: "astra_scheduler_queued_gpu_seconds",
  help: "Predicted GPU service seconds in the authoritative candidate snapshot",
  registers: [metrics],
});
const predictionCandidates = new Gauge({
  name: "astra_scheduler_prediction_candidates",
  help: "Candidates by service-time prediction source",
  labelNames: ["source"] as const,
  registers: [metrics],
});
const assignmentReasons = new Counter({
  name: "astra_scheduler_assignment_reasons_total",
  help: "Reserved assignments by fairness reason",
  labelNames: ["reason"] as const,
  registers: [metrics],
});
const capacityPlans = new Counter({
  name: "astra_capacity_plans_total",
  help: "Capacity plans persisted by outcome",
  labelNames: ["outcome"] as const,
  registers: [metrics],
});
const iterationDuration = new Histogram({
  name: "astra_scheduler_iteration_duration_seconds",
  help: "Duration of one deterministic scheduling iteration",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metrics],
});

const abort = new AbortController();
let loopHealthy = true;
let lastSuccessAt: Date | undefined;
let capacityLoopHealthy = true;

const run = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    const stopTimer = iterationDuration.startTimer();
    try {
      const result = await scheduler.runOnce();
      candidates.set({ kind: "tasks" }, result.consideredTasks);
      candidates.set({ kind: "replicas" }, result.consideredReplicas);
      queuedGpuSeconds.set(result.queuedGpuSeconds);
      predictionCandidates.set({ source: "profile" }, result.predictionSources.profile);
      predictionCandidates.set({ source: "cold_baseline" }, result.predictionSources.cold_baseline);
      for (const [reason, count] of Object.entries(result.assignmentReasons)) {
        assignmentReasons.inc({ reason }, count);
      }
      reservations.inc({ outcome: "reserved" }, result.reserved.length);
      reservations.inc({ outcome: "cas_conflict" }, result.conflicts);
      reservations.inc({ outcome: "expired" }, result.expired);
      iterations.inc({ outcome: "success" });
      loopHealthy = true;
      lastSuccessAt = new Date();
      if (result.reserved.length > 0 || result.expired > 0) {
        logger.info("scheduling_iteration_applied", {
          reserved: result.reserved.length,
          expired: result.expired,
          conflicts: result.conflicts,
        });
      }
    } catch (error) {
      loopHealthy = false;
      iterations.inc({ outcome: "failure" });
      logger.error("scheduling_iteration_failed", {
        error_code: error instanceof Error ? error.message : "scheduler_iteration_failed",
      });
    } finally {
      stopTimer();
    }
    await Bun.sleep(config.SCHEDULER_POLL_INTERVAL_MS);
  }
};

void run();
const runCapacity = async (): Promise<void> => {
  while (!abort.signal.aborted) {
    try {
      const result = await capacityPlanner.runOnce();
      capacityPlans.inc({ outcome: "planned" }, result.planned - result.suppressed - result.admissionControl);
      capacityPlans.inc({ outcome: "suppressed" }, result.suppressed);
      capacityPlans.inc({ outcome: "admission_control" }, result.admissionControl);
      capacityLoopHealthy = true;
    } catch (error) {
      capacityLoopHealthy = false;
      logger.error("capacity_planning_failed", {
        error_code: error instanceof Error ? error.message : "capacity_planning_failed",
      });
    }
    await Bun.sleep(5_000);
  }
};
void runCapacity();
const server = Bun.serve({
  port: config.SCHEDULER_METRICS_PORT,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") return Response.json({ status: "live", component: "scheduler" });
    if (path === "/health/ready") {
      const databaseReady = await databaseHealth.ready();
      const fresh = lastSuccessAt
        ? Date.now() - lastSuccessAt.getTime() <= Math.max(config.SCHEDULER_POLL_INTERVAL_MS * 10, 5_000)
        : false;
      const ready = databaseReady && loopHealthy && capacityLoopHealthy && fresh;
      return Response.json(
        {
          status: ready ? "ready" : "not_ready",
          database: databaseReady,
          loop: loopHealthy,
          capacity_loop: capacityLoopHealthy,
          fresh,
        },
        { status: ready ? 200 : 503 },
      );
    }
    if (path === "/metrics") return metricResponse(metrics);
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

const shutdown = async (): Promise<void> => {
  abort.abort();
  server.stop(true);
  await database.client.end({ timeout: 5 });
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
logger.info("scheduler_started", { port: config.SCHEDULER_METRICS_PORT });
