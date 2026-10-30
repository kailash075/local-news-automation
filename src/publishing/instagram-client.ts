import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";

/**
 * Client for the Instagram API with Instagram Login (host graph.instagram.com).
 * Endpoints and fields follow Meta's content publishing guide as read on 2026-10-29.
 * To confirm in Phase 2 against the live API, before the first real post:
 *  - that `Authorization: Bearer` header auth and JSON request bodies are accepted on every endpoint used here;
 *  - the exact field names of `content_publishing_limit` (`quota_usage`, `config.quota_total`, `config.quota_duration`);
 *  - that `alt_text` is accepted on image containers for this login type.
 * The access token is never placed in a URL, except for `refresh_access_token`, which Meta documents only with a
 * query parameter. That URL is never logged and errors are redacted.
 */

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export type InstagramApiError = {
  kind: "api_error";
  httpStatus: number;
  code?: number;
  subcode?: number;
  type?: string;
  isTransient?: boolean;
  /** Redacted. */
  message: string;
  fbtraceId?: string;
};

export type InstagramClientError =
  | InstagramApiError
  /** The request certainly did not reach Meta (DNS failure, connection refused). Safe to retry. */
  | { kind: "not_sent"; message: string }
  /** The request may have reached Meta but no usable answer came back (timeout, reset, unparseable body). */
  | { kind: "ambiguous"; message: string; httpStatus?: number };

export type PublishingLimit = { quotaUsage: number; quotaTotal?: number; quotaDurationSeconds?: number };

export type RecentMedia = { id: string; caption?: string; timestamp: string; permalink?: string };

export type RefreshedToken = { accessToken: string; expiresInSeconds: number };

export type InstagramClient = {
  createImageContainer: (p: {
    igUserId: string;
    imageUrl: string;
    caption: string;
    altText: string;
  }) => Promise<Result<{ containerId: string }, InstagramClientError>>;
  getContainerStatus: (containerId: string) => Promise<Result<{ status: ContainerStatus; detail?: string }, InstagramClientError>>;
  publishContainer: (igUserId: string, creationId: string) => Promise<Result<{ mediaId: string }, InstagramClientError>>;
  getPermalink: (mediaId: string) => Promise<Result<{ permalink: string }, InstagramClientError>>;
  getPublishingLimit: (igUserId: string) => Promise<Result<PublishingLimit, InstagramClientError>>;
  listRecentMedia: (igUserId: string, limit?: number) => Promise<Result<readonly RecentMedia[], InstagramClientError>>;
  refreshToken: () => Promise<Result<RefreshedToken, InstagramClientError>>;
};

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export type InstagramClientOptions = {
  fetch: FetchFn;
  accessToken: string;
  /** For example "v26.0". */
  graphVersion: string;
  timeoutMs?: number;
};

export const GRAPH_HOST = "https://graph.instagram.com";

// ---------------------------------------------------------------- response schemas

const IdResponse = z.object({ id: z.string().min(1) });
const StatusResponse = z.object({
  status_code: z.enum(["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED", "PUBLISHED"]),
  status: z.string().optional(),
});
const PermalinkResponse = z.object({ permalink: z.url() });
const LimitResponse = z.object({
  data: z
    .array(
      z.object({
        quota_usage: z.number().int().min(0),
        config: z.object({ quota_total: z.number().int().optional(), quota_duration: z.number().int().optional() }).optional(),
      }),
    )
    .min(1),
});
const MediaListResponse = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      caption: z.string().optional(),
      timestamp: z.string(),
      permalink: z.string().optional(),
    }),
  ),
});
const RefreshResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});
const ErrorEnvelope = z.object({
  error: z.object({
    message: z.string().default(""),
    type: z.string().optional(),
    code: z.number().int().optional(),
    error_subcode: z.number().int().optional(),
    is_transient: z.boolean().optional(),
    fbtrace_id: z.string().optional(),
  }),
});

// ---------------------------------------------------------------- redaction

/** Removes secrets and anything shaped like an access token from text that may be logged or stored. */
export const redact = (text: string, secrets: readonly string[] = []): string => {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 8) out = out.split(s).join("[REDACTED]");
  }
  return out
    .replace(/(access_token|ig_exchange_token|client_secret)=[^&\s"']+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/\bIG[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]");
};

/** Network failures that happen before any byte of the request can have been sent. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

const errorCode = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const direct = "code" in e && typeof e.code === "string" ? e.code : undefined;
  if (direct !== undefined) return direct;
  return "cause" in e ? errorCode(e.cause) : undefined;
};

const errorMessage = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// ---------------------------------------------------------------- client

export const createInstagramClient = (options: InstagramClientOptions): InstagramClient => {
  const { accessToken, graphVersion } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = `${GRAPH_HOST}/${graphVersion}`;
  const secrets = [accessToken];

  const call = async <T>(
    method: "GET" | "POST",
    url: string,
    schema: z.ZodType<T>,
    body?: Readonly<Record<string, string>>,
    auth: "header" | "none" = "header",
  ): Promise<Result<T, InstagramClientError>> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth === "header") headers["Authorization"] = `Bearer ${accessToken}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await options.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (e: unknown) {
      const code = errorCode(e);
      const message = redact(`${errorMessage(e)}${code === undefined ? "" : ` (${code})`}`, secrets);
      return code !== undefined && NOT_SENT_CODES.has(code) ? err({ kind: "not_sent", message }) : err({ kind: "ambiguous", message });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (e: unknown) {
      return err({ kind: "ambiguous", httpStatus: response.status, message: redact(errorMessage(e), secrets) });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const envelope = ErrorEnvelope.safeParse(json);
      if (!envelope.success) {
        const message = redact(`HTTP ${response.status} without a Meta error body`, secrets);
        // A 5xx without Meta's envelope may come from a proxy after the request was processed.
        return response.status >= 500
          ? err({ kind: "ambiguous", httpStatus: response.status, message })
          : err({ kind: "api_error", httpStatus: response.status, message });
      }
      const e = envelope.data.error;
      return err({
        kind: "api_error",
        httpStatus: response.status,
        message: redact(e.message, secrets),
        ...(e.code === undefined ? {} : { code: e.code }),
        ...(e.error_subcode === undefined ? {} : { subcode: e.error_subcode }),
        ...(e.type === undefined ? {} : { type: e.type }),
        ...(e.is_transient === undefined ? {} : { isTransient: e.is_transient }),
        ...(e.fbtrace_id === undefined ? {} : { fbtraceId: e.fbtrace_id }),
      });
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return err({ kind: "ambiguous", httpStatus: response.status, message: "unexpected response shape from Meta" });
    }
    return ok(parsed.data);
  };

  const path = (...segments: string[]): string => `${base}/${segments.map(encodeURIComponent).join("/")}`;

  return {
    createImageContainer: async ({ igUserId, imageUrl, caption, altText }) => {
      const r = await call("POST", path(igUserId, "media"), IdResponse, { image_url: imageUrl, caption, alt_text: altText });
      return r.ok ? ok({ containerId: r.value.id }) : r;
    },

    getContainerStatus: async (containerId) => {
      const r = await call("GET", `${path(containerId)}?fields=status_code,status`, StatusResponse);
      if (!r.ok) return r;
      return ok({ status: r.value.status_code, ...(r.value.status === undefined ? {} : { detail: r.value.status }) });
    },

    publishContainer: async (igUserId, creationId) => {
      const r = await call("POST", path(igUserId, "media_publish"), IdResponse, { creation_id: creationId });
      return r.ok ? ok({ mediaId: r.value.id }) : r;
    },

    getPermalink: async (mediaId) => {
      const r = await call("GET", `${path(mediaId)}?fields=permalink`, PermalinkResponse);
      return r.ok ? ok({ permalink: r.value.permalink }) : r;
    },

    getPublishingLimit: async (igUserId) => {
      const r = await call("GET", `${path(igUserId, "content_publishing_limit")}?fields=quota_usage,config`, LimitResponse);
      if (!r.ok) return r;
      const first = r.value.data[0];
      if (first === undefined) return err({ kind: "ambiguous", message: "empty content_publishing_limit response" });
      return ok({
        quotaUsage: first.quota_usage,
        ...(first.config?.quota_total === undefined ? {} : { quotaTotal: first.config.quota_total }),
        ...(first.config?.quota_duration === undefined ? {} : { quotaDurationSeconds: first.config.quota_duration }),
      });
    },

    listRecentMedia: async (igUserId, limit = 25) => {
      const r = await call(
        "GET",
        `${path(igUserId, "media")}?fields=id,caption,timestamp,permalink&limit=${Math.min(Math.max(limit, 1), 50)}`,
        MediaListResponse,
      );
      if (!r.ok) return r;
      return ok(
        r.value.data.map((m) => ({
          id: m.id,
          timestamp: m.timestamp,
          ...(m.caption === undefined ? {} : { caption: m.caption }),
          ...(m.permalink === undefined ? {} : { permalink: m.permalink }),
        })),
      );
    },

    refreshToken: async () => {
      // Documented only with the token as a query parameter. This URL must never be logged.
      const url = `${GRAPH_HOST}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`;
      const r = await call("GET", url, RefreshResponse, undefined, "none");
      return r.ok ? ok({ accessToken: r.value.access_token, expiresInSeconds: r.value.expires_in }) : r;
    },
  };
};
