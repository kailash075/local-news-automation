import { describe, expect, it } from "vitest";
import { createCloudinaryObjectStore, signParams } from "./cloudinary.ts";

type Call = { url: string; method: string; form?: FormData };

const fakeFetch = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    const call: Call = { url, method: init?.method ?? "GET", ...(init?.body instanceof FormData ? { form: init.body } : {}) };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, fetchImpl };
};

const KEY = "renders/2026/10/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg";
const PUBLIC_ID = "erodeglitz/renders/2026/10/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const store = (fetchImpl: ReturnType<typeof fakeFetch>["fetchImpl"]) =>
  createCloudinaryObjectStore({
    cloudName: "demo-cloud",
    apiKey: "123456789012345",
    apiSecret: "secret-abc",
    folder: "erodeglitz",
    fetch: fetchImpl,
    now: () => new Date("2026-10-30T04:30:00Z"),
  });

describe("Cloudinary object store", () => {
  it("signs parameters the way Cloudinary documents", () => {
    // The example from Cloudinary's "Generating authentication signatures" documentation.
    expect(
      signParams({ timestamp: "1315060510", public_id: "sample_image", eager: "w_400,h_300,c_pad|w_260,h_200,c_crop" }, "abcd"),
    ).toBe("bfd09f95f331f558cbd1320e67aa8d488770583e");
  });

  it("uploads with a signature, never overwriting, under the folder", async () => {
    const f = fakeFetch(() => Response.json({ public_id: PUBLIC_ID, secure_url: "https://res.cloudinary.com/x.jpg" }));
    await store(f.fetchImpl).put(KEY, new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");
    const [call] = f.calls;
    expect(call?.url).toBe("https://api.cloudinary.com/v1_1/demo-cloud/image/upload");
    expect(call?.form?.get("public_id")).toBe(PUBLIC_ID);
    expect(call?.form?.get("overwrite")).toBe("false");
    expect(call?.form?.get("timestamp")).toBe("1793334600");
    expect(call?.form?.get("api_key")).toBe("123456789012345");
    expect(call?.form?.get("signature")).toBe(signParams({ overwrite: "false", public_id: PUBLIC_ID, timestamp: "1793334600" }, "secret-abc"));
    expect(call?.form?.has("api_secret")).toBe(false);
    expect(call?.form?.get("file")).toBeInstanceOf(Blob);
  });

  it("reports a refused upload without leaking the secret, and retries a server error once", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n += 1;
      return n === 1 ? new Response("", { status: 503 }) : Response.json({ error: { message: "Invalid Signature api_secret=secret-abc" } }, { status: 401 });
    });
    await expect(store(f.fetchImpl).put(KEY, new Uint8Array([1]), "image/jpeg")).rejects.toThrow(/HTTP 401 Invalid Signature api_secret=\[REDACTED\]/);
    expect(n).toBe(2);
  });

  it("gives public delivery URLs and reads the stored bytes back", async () => {
    const f = fakeFetch((call) => (call.url.endsWith(".jpg") && call.method === "GET" ? new Response(new Uint8Array([1, 2, 3])) : new Response(null, { status: 404 })));
    const s = store(f.fetchImpl);
    expect(await s.publicUrl(KEY)).toBe(`https://res.cloudinary.com/demo-cloud/image/upload/${PUBLIC_ID}.jpg`);
    expect(await s.get(KEY)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await s.exists(KEY)).toBe(false);
  });

  it("refuses keys that are not card renders", async () => {
    const f = fakeFetch(() => new Response(null, { status: 200 }));
    await expect(store(f.fetchImpl).publicUrl("../etc/passwd")).rejects.toThrow(/object key must look like/);
    await expect(store(f.fetchImpl).publicUrl("renders/a.png")).rejects.toThrow(/object key must look like/);
  });
});
