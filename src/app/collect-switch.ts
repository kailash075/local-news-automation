import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";
import type { SettingsStore } from "../domain/ports.ts";
import type { GitHubLogin } from "../domain/types.ts";

/** Coimbatore 360's collect-switch: Actions -> collect-switch -> pause or start. */
export const CollectSwitchRequestSchema = z.strictObject({
  collect: z.enum(["pause", "start"]),
  actor: z.string().min(1),
});

export type CollectSwitchRequest = z.infer<typeof CollectSwitchRequestSchema>;

/** Anyone allowed to run the workflow may pause; only the owner may start. */
export const applyCollectSwitch = async (
  settings: SettingsStore,
  request: CollectSwitchRequest,
  owner: GitHubLogin | undefined,
): Promise<Result<string, string>> => {
  if (request.collect === "start" && (owner === undefined || request.actor !== owner)) {
    return err("Only the owner (OWNER_GITHUB_LOGIN) can start automatic collecting.");
  }
  await settings.setSwitch("collecting_enabled", request.collect === "start", request.actor, `collect-switch ${request.collect}`);
  const after = await settings.getSwitch("collecting_enabled");
  return ok(after.enabled ? "Automatic collecting: ON" : "Automatic collecting: PAUSED (posting continues)");
};

/**
 * Scheduled collect and draft runs work only while automatic collecting is started. A run started by hand or by another
 * workflow always works, as in Coimbatore 360. Returns why a scheduled run has to stop, or undefined.
 */
export const scheduledRunPaused = async (settings: Pick<SettingsStore, "getSwitch">, scheduled: boolean): Promise<string | undefined> => {
  if (!scheduled) return undefined;
  const collecting = await settings.getSwitch("collecting_enabled");
  return collecting.enabled ? undefined : collecting.reason;
};
