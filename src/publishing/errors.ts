import { assertNever } from "../lib/result.ts";
import type { InstagramClientError } from "./instagram-client.ts";

/** Error classes from docs/ARCHITECTURE.md §5.10. Codes are from Meta's Instagram Platform error reference. */
export type ErrorClass = "transient" | "new_container" | "fix_required" | "quota" | "account_or_auth" | "ambiguous" | "unknown";

export type ErrorAction =
  | "retry_with_backoff"
  | "create_new_container"
  | "fail_and_alert"
  | "reschedule_after_quota_window"
  | "trip_kill_switch"
  | "reconcile";

const TRANSIENT_SUBCODES: ReadonlySet<number> = new Set([2207001, 2207003, 2207008, 2207027]);
const NEW_CONTAINER_SUBCODES: ReadonlySet<number> = new Set([2207006, 2207020, 2207032]);
const FIX_REQUIRED_SUBCODES: ReadonlySet<number> = new Set([2207004, 2207005, 2207009, 2207010, 2207040, 2207052]);
const FIX_REQUIRED_CODES: ReadonlySet<number> = new Set([9004, 36000, 36001, 36003, 36004]);
const ACCOUNT_SUBCODES: ReadonlySet<number> = new Set([2207050, 2207051]);
/** 190 invalid or expired token, 102 session, 10 and 200 to 299 permission errors, 25 account restricted. */
const AUTH_CODES: ReadonlySet<number> = new Set([10, 25, 102, 190]);
/** 9 publishing limit; 4, 17, 32 and 613 are request rate limits. */
const QUOTA_CODES: ReadonlySet<number> = new Set([4, 9, 17, 32, 613]);

export const classifyError = (e: InstagramClientError): ErrorClass => {
  switch (e.kind) {
    case "not_sent":
      return "transient";
    case "ambiguous":
      return "ambiguous";
    case "api_error": {
      const { code, subcode } = e;
      // Order matters: spam and restriction subcodes arrive with codes (4, 25) that would otherwise look like rate limits.
      if (subcode !== undefined && ACCOUNT_SUBCODES.has(subcode)) return "account_or_auth";
      if (code !== undefined && (AUTH_CODES.has(code) || (code >= 200 && code <= 299))) return "account_or_auth";
      if (e.type === "OAuthException" && e.httpStatus === 401) return "account_or_auth";
      if (subcode === 2207042) return "quota";
      if (subcode !== undefined && TRANSIENT_SUBCODES.has(subcode)) return "transient";
      if (subcode !== undefined && NEW_CONTAINER_SUBCODES.has(subcode)) return "new_container";
      if (subcode !== undefined && FIX_REQUIRED_SUBCODES.has(subcode)) return "fix_required";
      if (code !== undefined && FIX_REQUIRED_CODES.has(code)) return "fix_required";
      if (code !== undefined && QUOTA_CODES.has(code)) return "quota";
      if (e.isTransient === true || e.httpStatus >= 500) return "transient";
      return "unknown";
    }
    default:
      return assertNever(e);
  }
};

export const actionFor = (c: ErrorClass): ErrorAction => {
  switch (c) {
    case "transient":
      return "retry_with_backoff";
    case "new_container":
      return "create_new_container";
    case "fix_required":
    case "unknown":
      return "fail_and_alert";
    case "quota":
      return "reschedule_after_quota_window";
    case "account_or_auth":
      return "trip_kill_switch";
    case "ambiguous":
      return "reconcile";
    default:
      return assertNever(c);
  }
};

export const MAX_TRANSIENT_ATTEMPTS = 5;

/** Exponential backoff: 2, 4, 8, 16, 32 minutes. */
export const backoffMs = (attempt: number): number => 2 ** Math.min(Math.max(attempt, 1), 5) * 60_000;

export const describeClientError = (e: InstagramClientError): string => {
  switch (e.kind) {
    case "api_error":
      return `HTTP ${e.httpStatus} code ${e.code ?? "-"}/${e.subcode ?? "-"}: ${e.message}`;
    case "not_sent":
      return `not sent: ${e.message}`;
    case "ambiguous":
      return `no clear answer${e.httpStatus === undefined ? "" : ` (HTTP ${e.httpStatus})`}: ${e.message}`;
    default:
      return assertNever(e);
  }
};
