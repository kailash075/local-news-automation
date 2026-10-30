import { err, ok, type Result } from "../lib/result.ts";

/**
 * Polite HTTP GET for collectors. The bot always names itself and a contact URL; it never pretends to be a browser.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const BOT_NAME = "ErodeGlitzBot";
export const BOT_VERSION = "0.1";

export const userAgent = (contactUrl: string): string => `${BOT_NAME}/${BOT_VERSION} (+${contactUrl})`;

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export type HttpGetRequest = {
  url: string;
  etag?: string;
  lastModified?: string;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

export type HttpGetOk =
  | {
      kind: "ok";
      status: number;
      finalUrl: string;
      body: string;
      contentType?: string;
      etag?: string;
      lastModified?: string;
    }
  | { kind: "not_modified"; status: 304 };

export type HttpGetError =
  | { kind: "timeout"; message: string }
  | { kind: "network"; message: string }
  | { kind: "too_large"; message: string; maxBytes: number }
  | { kind: "http_status"; message: string; status: number }
  | { kind: "rate_limited"; message: string; status: 429 | 503; retryAfterSeconds?: number };

export type HttpDeps = {
  fetch?: FetchLike;
  contactUrl: string;
  /** Current time, for parsing an HTTP-date Retry-After. */
  now?: () => Date;
};

/** Retry-After as seconds, from either delta-seconds or an HTTP-date. */
export const parseRetryAfter = (value: string | null, now: Date): number | undefined => {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
};

const charsetOf = (contentType: string | undefined): string => {
  const m = contentType === undefined ? null : /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  return m?.[1]?.toLowerCase() ?? "utf-8";
};

const decode = (bytes: Uint8Array, contentType: string | undefined): string => {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

/** Reads the body, stopping (and cancelling the stream) once it exceeds `maxBytes`. */
const readLimited = async (response: Response, maxBytes: number): Promise<Uint8Array | "too_large"> => {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return "too_large";
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
};

const isTimeout = (e: unknown): boolean =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

export const httpGet = async (request: HttpGetRequest, deps: HttpDeps): Promise<Result<HttpGetOk, HttpGetError>> => {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers = new Headers({
    "User-Agent": userAgent(deps.contactUrl),
    Accept: request.accept ?? "*/*",
  });
  if (request.etag !== undefined) headers.set("If-None-Match", request.etag);
  if (request.lastModified !== undefined) headers.set("If-Modified-Since", request.lastModified);

  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    if (isTimeout(e)) return err({ kind: "timeout", message: `timed out fetching ${request.url}` });
    return err({ kind: "network", message: e instanceof Error ? e.message : String(e) });
  }

  if (response.status === 304) {
    await response.body?.cancel();
    return ok({ kind: "not_modified", status: 304 });
  }
  if (response.status === 429 || response.status === 503) {
    await response.body?.cancel();
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), deps.now?.() ?? new Date());
    return err({
      kind: "rate_limited",
      status: response.status,
      message: `HTTP ${response.status} from ${request.url}`,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    return err({ kind: "http_status", status: response.status, message: `HTTP ${response.status} from ${request.url}` });
  }

  let bytes: Uint8Array | "too_large";
  try {
    bytes = await readLimited(response, maxBytes);
  } catch (e: unknown) {
    if (isTimeout(e)) return err({ kind: "timeout", message: `timed out reading ${request.url}` });
    return err({ kind: "network", message: e instanceof Error ? e.message : String(e) });
  }
  if (bytes === "too_large") return err({ kind: "too_large", maxBytes, message: `body larger than ${maxBytes} bytes` });

  const contentType = response.headers.get("content-type") ?? undefined;
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  return ok({
    kind: "ok",
    status: response.status,
    finalUrl: response.url === "" ? request.url : response.url,
    body: decode(bytes, contentType),
    ...(contentType === undefined ? {} : { contentType }),
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  });
};
