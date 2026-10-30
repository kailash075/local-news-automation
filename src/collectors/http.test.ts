import { describe, expect, it } from "vitest";
import { httpGet, parseRetryAfter, userAgent, type FetchLike } from "./http.ts";

const CONTACT = "https://github.com/kailash075/local-news-automation";

const recordingFetch = (response: () => Response): { fetch: FetchLike; requests: { url: string; headers: Headers }[] } => {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch: FetchLike = (input, init) => {
    requests.push({ url: input, headers: new Headers(init?.headers) });
    return Promise.resolve(response());
  };
  return { fetch, requests };
};

describe("httpGet", () => {
  it("identifies the bot honestly and never as a browser", async () => {
    const { fetch, requests } = recordingFetch(() => new Response("ok"));
    await httpGet({ url: "https://example.com/feed" }, { fetch, contactUrl: CONTACT });
    const ua = requests[0]?.headers.get("user-agent") ?? "";
    expect(ua).toBe(userAgent(CONTACT));
    expect(ua).toMatch(/^ErodeGlitzBot\/0\.1 \(\+https:/);
    expect(ua).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("sends conditional headers and handles 304", async () => {
    const { fetch, requests } = recordingFetch(() => new Response(null, { status: 304 }));
    const r = await httpGet({ url: "https://example.com/feed", etag: '"abc"', lastModified: "Wed, 29 Oct 2026 10:00:00 GMT" }, { fetch, contactUrl: CONTACT });
    expect(r).toEqual({ ok: true, value: { kind: "not_modified", status: 304 } });
    expect(requests[0]?.headers.get("if-none-match")).toBe('"abc"');
    expect(requests[0]?.headers.get("if-modified-since")).toBe("Wed, 29 Oct 2026 10:00:00 GMT");
  });

  it("returns the body, validators and content type", async () => {
    const { fetch } = recordingFetch(
      () => new Response("ஈரோடு", { headers: { "content-type": "text/html; charset=utf-8", etag: '"v2"', "last-modified": "Thu, 30 Oct 2026 05:00:00 GMT" } }),
    );
    const r = await httpGet({ url: "https://example.com/" }, { fetch, contactUrl: CONTACT });
    expect(r.ok && r.value.kind === "ok" ? r.value : undefined).toMatchObject({
      body: "ஈரோடு",
      etag: '"v2"',
      lastModified: "Thu, 30 Oct 2026 05:00:00 GMT",
      contentType: "text/html; charset=utf-8",
    });
  });

  it("reports 429 and 503 with a retry hint", async () => {
    const { fetch } = recordingFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }));
    const r = await httpGet({ url: "https://example.com/" }, { fetch, contactUrl: CONTACT });
    expect(r).toEqual({ ok: false, error: { kind: "rate_limited", status: 429, retryAfterSeconds: 120, message: "HTTP 429 from https://example.com/" } });
  });

  it("reports other statuses", async () => {
    const { fetch } = recordingFetch(() => new Response("gone", { status: 404 }));
    const r = await httpGet({ url: "https://example.com/x" }, { fetch, contactUrl: CONTACT });
    expect(r.ok ? undefined : r.error).toMatchObject({ kind: "http_status", status: 404 });
  });

  it("refuses bodies over the size limit", async () => {
    const { fetch } = recordingFetch(() => new Response("x".repeat(2000)));
    const r = await httpGet({ url: "https://example.com/big", maxBytes: 1000 }, { fetch, contactUrl: CONTACT });
    expect(r.ok ? undefined : r.error.kind).toBe("too_large");
  });

  it("maps timeouts and network errors", async () => {
    const timeout: FetchLike = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
    expect(await httpGet({ url: "https://example.com/" }, { fetch: timeout, contactUrl: CONTACT })).toMatchObject({ ok: false, error: { kind: "timeout" } });
    const broken: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    expect(await httpGet({ url: "https://example.com/" }, { fetch: broken, contactUrl: CONTACT })).toMatchObject({ ok: false, error: { kind: "network" } });
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    const now = new Date("2026-10-30T06:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("Thu, 30 Oct 2026 06:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
});
