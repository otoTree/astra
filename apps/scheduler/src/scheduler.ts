import type { Reservation, SchedulingRepository } from "@astra/database";
import { planDeterministicAssignments } from "@astra/queue";

export type SchedulerRunResult = Readonly<{
  expired: number;
  consideredTasks: number;
  consideredReplicas: number;
  planned: number;
  reserved: readonly Reservation[];
  conflicts: number;
}>;

export class DeterministicScheduler {
  constructor(
    private readonly repository: SchedulingRepository,
    private readonly options: Readonly<{
      batchSize: number;
      reservationSeconds: number;
      workerFreshnessSeconds: number;
    }>,
    private readonly createId: (prefix: string) => string = (prefix) => `${prefix}_${Bun.randomUUIDv7()}`,
  ) {}

  async runOnce(): Promise<SchedulerRunResult> {
    const expired = await this.repository.expireReservations(this.options.batchSize);
    const snapshot = await this.repository.snapshot(this.options.batchSize, this.options.workerFreshnessSeconds);
    const assignments = planDeterministicAssignments(snapshot.tasks, snapshot.replicas);
    const reserved: Reservation[] = [];
    let conflicts = 0;
    for (const assignment of assignments) {
      const reservation = await this.repository.reserve({
        decisionId: this.createId("decision"),
        attemptId: this.createId("attempt"),
        leaseId: this.createId("lease"),
        executionKey: this.createId("execution"),
        traceId: this.createId("trace"),
        task: assignment.task,
        replica: assignment.replica,
        slotIndex: assignment.slotIndex,
        reason: assignment.reason,
        reservationSeconds: this.options.reservationSeconds,
        workerFreshnessSeconds: this.options.workerFreshnessSeconds,
        inputSnapshot: {
          observed_at: snapshot.observedAt,
          task: assignment.task,
          replica: assignment.replica,
          slot_index: assignment.slotIndex,
        },
      });
      if (reservation) reserved.push(reservation);
      else conflicts += 1;
    }
    return {
      expired,
      consideredTasks: snapshot.tasks.length,
      consideredReplicas: snapshot.replicas.length,
      planned: assignments.length,
      reserved,
      conflicts,
    };
  }
}
