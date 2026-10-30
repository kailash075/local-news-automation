import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";
import type { SettingsStore, SwitchKey } from "../domain/ports.ts";
import type { GitHubLogin } from "../domain/types.ts";

export const SwitchRequestSchema = z.strictObject({
  name: z.enum(["publishing", "collecting"]),
  state: z.enum(["on", "off"]),
  reason: z.string().trim().min(3).max(300),
  actor: z.string().min(1),
});

export type SwitchRequest = z.infer<typeof SwitchRequestSchema>;

const KEY: Readonly<Record<SwitchRequest["name"], SwitchKey>> = {
  publishing: "publishing_enabled",
  collecting: "collecting_enabled",
};

/** Anyone allowed to run the workflow may switch something off; only the owner may switch it on. */
export const applySwitch = async (
  settings: SettingsStore,
  request: SwitchRequest,
  owner: GitHubLogin | undefined,
): Promise<Result<string, string>> => {
  const key = KEY[request.name];
  if (request.state === "on" && (owner === undefined || request.actor !== owner)) {
    return err(`Only the owner (OWNER_GITHUB_LOGIN) can switch ${request.name} on.`);
  }
  await settings.setSwitch(key, request.state === "on", request.actor, request.reason);
  const after = await settings.getSwitch(key);
  return ok(`${request.name} is now ${after.enabled ? "ON" : "OFF"} (by ${after.updatedBy}: ${after.reason})`);
};
