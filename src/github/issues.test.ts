import { describe, expect, it } from "vitest";
import { createIssuesClient } from "./issues.ts";

const recording = () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const client = createIssuesClient({
    token: "test-token",
    repository: "kailash075/local-news-automation",
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, method: init?.method ?? "GET", body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown });
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  return { requests, client };
};

describe("issues client", () => {
  it("update sends the new title and body in one PATCH", async () => {
    const { requests, client } = recording();
    expect((await client.update(4, "சிவகிரி வாரச்சந்தை (business)", "body text")).ok).toBe(true);
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/kailash075/local-news-automation/issues/4",
        method: "PATCH",
        body: { title: "சிவகிரி வாரச்சந்தை (business)", body: "body text" },
      },
    ]);
  });

  it("closes an expired story's issue as not planned, and reopens it", async () => {
    const { requests, client } = recording();
    expect((await client.close(4, "not_planned")).ok).toBe(true);
    expect((await client.reopen(4)).ok).toBe(true);
    expect(requests.map((r) => [r.method, r.url.split("/repos/")[1], r.body])).toEqual([
      ["PATCH", "kailash075/local-news-automation/issues/4", { state: "closed", state_reason: "not_planned" }],
      ["PATCH", "kailash075/local-news-automation/issues/4", { state: "open" }],
    ]);
  });
});
