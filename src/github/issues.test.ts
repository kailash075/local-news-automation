import { describe, expect, it } from "vitest";
import { createIssuesClient } from "./issues.ts";

describe("issues client", () => {
  it("update sends the new title and body in one PATCH", async () => {
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
    expect((await client.update(4, "சிவகிரி வாரச்சந்தை (business)", "body text")).ok).toBe(true);
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/kailash075/local-news-automation/issues/4",
        method: "PATCH",
        body: { title: "சிவகிரி வாரச்சந்தை (business)", body: "body text" },
      },
    ]);
  });
});
