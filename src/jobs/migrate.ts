import { createBridgeFromEnv, loadEnv, missingForSheet } from "../config/env.ts";
import { appendSummary } from "../ops/actions.ts";
import { log, registerSecret } from "../ops/logger.ts";
import { setupSheet } from "../sheet/setup.ts";

/** Creates the Sheet's tabs and columns (never removes any) and checks that Sheets stores text exactly. */
const env = loadEnv();
const missing = missingForSheet(env);
if (missing.length > 0) {
  appendSummary(`### migrate: setup not finished\nMissing: ${missing.map((m) => `\`${m}\``).join(", ")}. Nothing was done.`);
} else {
  registerSecret(env.SHEET_BRIDGE_URL);
  registerSecret(env.SHEET_BRIDGE_KEY);
  try {
    const report = await setupSheet(createBridgeFromEnv(env));
    const lines = [
      "### migrate",
      `Sheet layout: \`${report.schemaVersion}\``,
      `Tabs created: ${report.created.length === 0 ? "none" : report.created.join(", ")}`,
      `Tabs with new columns: ${report.extended.length === 0 ? "none" : report.extended.join(", ")}`,
    ];
    if (report.selfTestFailures.length > 0) {
      process.exitCode = 1;
      lines.push(
        "**Self test failed: Sheets changed these values. Do not run the pipeline until this is fixed.**",
        ...report.selfTestFailures.map((f) => `- sent ${JSON.stringify(f.sent)}, got back ${JSON.stringify(f.received)}`),
      );
    } else {
      lines.push(`Self test: all values came back unchanged.`);
    }
    appendSummary(lines.join("\n"));
  } catch (error) {
    process.exitCode = 1;
    log.error("Sheet setup failed", { error });
    appendSummary("### migrate: failed\nSee the job log.");
  }
}
