import { createBridgeFromEnv, loadEnv, missingForSheet, type Env } from "../config/env.ts";
import type { Clock, JobRunId, Stores } from "../domain/ports.ts";
import { parseEncryptionKey } from "../lib/crypto.ts";
import { appendSummary } from "../ops/actions.ts";
import { log, registerSecret } from "../ops/logger.ts";
import type { BridgeClient } from "../sheet/bridge.ts";
import { assertSheetSchema } from "../sheet/setup.ts";
import { createSheetStores } from "../sheet/stores.ts";

export type JobContext = {
  env: Env;
  bridge: BridgeClient;
  stores: Stores;
  clock: Clock;
  jobRunId: JobRunId;
  /** Counted events, saved with the job run. */
  count: (name: string, by?: number) => void;
};

export type JobOutcome = "succeeded" | "skipped";

const systemClock: Clock = { now: () => new Date() };

/**
 * Shared job wrapper: configuration check, Sheet layout check, job-run row, error row.
 * Missing configuration is not a failure: like Coimbatore 360's "Setup not finished", the job reports what is missing
 * and exits cleanly, because the owner has not created the accounts yet.
 */
export const runJob = async (
  name: string,
  body: (ctx: JobContext) => Promise<JobOutcome>,
  options: { requires?: (env: Env) => readonly string[]; bridge?: (env: Env) => BridgeClient } = {},
): Promise<void> => {
  const env = loadEnv();
  registerSecret(env.SHEET_BRIDGE_URL);
  registerSecret(env.SHEET_BRIDGE_KEY);
  registerSecret(env.CLOUDINARY_API_SECRET);
  registerSecret(env.TOKEN_ENCRYPTION_KEY);

  const missing = [...missingForSheet(env), ...(options.requires?.(env) ?? [])];
  if (missing.length > 0) {
    appendSummary(`### ${name}: setup not finished\nMissing: ${missing.map((m) => `\`${m}\``).join(", ")}. Nothing was done.`);
    log.warn("setup not finished", { job: name, missing });
    return;
  }

  const bridge = (options.bridge ?? createBridgeFromEnv)(env);
  const counters: Record<string, number> = {};
  let jobRunId: JobRunId | undefined;
  let stores: Stores | undefined;
  try {
    await assertSheetSchema(bridge);
    stores = createSheetStores(bridge, {
      clock: systemClock,
      ...(env.TOKEN_ENCRYPTION_KEY === undefined ? {} : { tokenKey: parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY) }),
    });
    jobRunId = await stores.jobRuns.start(env.GITHUB_WORKFLOW, env.GITHUB_RUN_ID, env.GITHUB_SHA);
    const outcome = await body({
      env,
      bridge,
      stores,
      clock: systemClock,
      jobRunId,
      count: (key, by = 1) => {
        counters[key] = (counters[key] ?? 0) + by;
      },
    });
    await stores.jobRuns.finish(jobRunId, outcome, counters);
    log.info("job finished", { job: name, outcome, counters });
  } catch (error) {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    log.error("job failed", { job: name, error });
    if (stores !== undefined && jobRunId !== undefined) {
      await stores.jobRuns
        .recordError({ jobRunId, stage: name, errorClass: error instanceof Error ? error.name : "unknown", message, retryable: true })
        .catch(() => undefined);
      await stores.jobRuns.finish(jobRunId, "failed", counters).catch(() => undefined);
    }
    appendSummary(`### ${name}: failed\nSee the job log. The error is also written to the Sheet's errors tab when the Sheet was reachable.`);
  }
};
