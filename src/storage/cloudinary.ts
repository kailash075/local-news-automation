import { createHash } from "node:crypto";
import type { FetchLike } from "../collectors/http.ts";
import type { ObjectStore } from "../domain/ports.ts";
import { redact } from "../lib/redact.ts";

/**
 * Card images on Cloudinary, as Coimbatore 360 does: Instagram fetches the JPEG from a public delivery URL.
 * Uploads are signed with the API secret (no unsigned upload preset that anyone could use), and never overwrite:
 * the object key holds the image's SHA-256, so the same key always means the same bytes.
 */

export type CloudinaryOptions = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Top-level folder of every public id, e.g. "erodeglitz". */
  folder: string;
  fetch?: FetchLike;
  now?: () => Date;
};

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_-]*\.jpg$/;

/** Cloudinary's signature: parameters sorted by name, joined as k=v with "&", the API secret appended, SHA-1 hex. */
export const signParams = (params: Readonly<Record<string, string>>, apiSecret: string): string =>
  createHash("sha1")
    .update(
      Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k] ?? ""}`)
        .join("&") + apiSecret,
    )
    .digest("hex");

export const createCloudinaryObjectStore = (options: CloudinaryOptions): ObjectStore => {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const publicId = (key: string): string => {
    if (!KEY_PATTERN.test(key)) throw new Error(`object key must look like renders/yyyy/mm/<sha>.jpg, got ${key.slice(0, 80)}`);
    return `${options.folder}/${key.slice(0, -".jpg".length)}`;
  };
  const deliveryUrl = (key: string): string => `https://res.cloudinary.com/${options.cloudName}/image/upload/${publicId(key)}.jpg`;

  const uploadOnce = async (key: string, bytes: Uint8Array, contentType: string): Promise<Response> => {
    const params = { overwrite: "false", public_id: publicId(key), timestamp: String(Math.floor(now().getTime() / 1000)) };
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: contentType }), "card.jpg");
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    form.set("api_key", options.apiKey);
    form.set("signature", signParams(params, options.apiSecret));
    return fetchImpl(`https://api.cloudinary.com/v1_1/${options.cloudName}/image/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  };

  return {
    put: async (key, bytes, contentType) => {
      let res: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          res = await uploadOnce(key, bytes, contentType);
        } catch (error) {
          if (attempt === 1) throw new Error(`Cloudinary upload failed: ${error instanceof Error ? error.name : "unknown"}`, { cause: error });
          continue;
        }
        if (res.status < 500) break;
      }
      if (res === undefined) throw new Error("Cloudinary upload failed");
      const body = (await res.json().catch(() => ({}))) as { public_id?: unknown; error?: { message?: unknown } };
      const reason = typeof body.error?.message === "string" ? body.error.message : "";
      if (!res.ok) throw new Error(`Cloudinary upload failed: HTTP ${res.status} ${redact(reason, 300)}`);
      if (body.public_id !== publicId(key)) throw new Error("Cloudinary stored the card under an unexpected public id");
    },
    get: async (key) => {
      const res = await fetchImpl(deliveryUrl(key), { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`Cloudinary download failed: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    exists: async (key) => {
      const res = await fetchImpl(deliveryUrl(key), { method: "HEAD", signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`Cloudinary check failed: HTTP ${res.status}`);
      return true;
    },
    publicUrl: (key) => Promise.resolve().then(() => deliveryUrl(key)),
  };
};
