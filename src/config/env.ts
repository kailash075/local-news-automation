import { z } from "zod";
import type { ObjectStore } from "../domain/ports.ts";
import { GitHubLoginSchema, type GitHubLogin } from "../domain/types.ts";
import { createBridgeClient, type BridgeClient } from "../sheet/bridge.ts";
import { createCloudinaryObjectStore } from "../storage/cloudinary.ts";

/**
 * Environment configuration. Every safety-relevant value fails closed: dry run is on unless a variable says otherwise
 * in exactly the expected form. Going live is not a variable: it is the LIVE file in the repository root (./live.ts).
 */

/** Only the exact string "true" turns a switch on. Anything else, including a missing variable, is off. */
const onlyExactTrue = z
  .string()
  .optional()
  .transform((v) => v === "true");

/** Dry run stays on unless the variable is exactly "false". */
const dryRunUnlessExactFalse = z
  .string()
  .optional()
  .transform((v) => v !== "false");

const loginList = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const logins: GitHubLogin[] = [];
    for (const raw of (v ?? "").split(",")) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const parsed = GitHubLoginSchema.safeParse(trimmed);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: `invalid GitHub login: ${trimmed}` });
        return z.NEVER;
      }
      logins.push(parsed.data);
    }
    return logins;
  });

const postingWindow = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/)
  .default("08:00-21:00")
  .transform((v) => {
    const [start = "", end = ""] = v.split("-");
    const minutes = (hhmm: string): number => {
      const [h = "0", m = "0"] = hhmm.split(":");
      return Number(h) * 60 + Number(m);
    };
    return { startMinute: minutes(start), endMinute: minutes(end) };
  })
  .refine((w) => w.startMinute < w.endMinute, "posting window must start before it ends");

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

export const EnvSchema = z.object({
  DRY_RUN: dryRunUnlessExactFalse,
  /** Repository variable: "true" stops all posting (Coimbatore 360's full stop). */
  PAUSED: onlyExactTrue,

  /** The Apps Script web app of the "ErodeGlitz Newsroom" Sheet (apps-script/Code.gs), ending in /exec. */
  SHEET_BRIDGE_URL: optionalNonEmpty.refine(
    (v) => v === undefined || /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(v),
    "SHEET_BRIDGE_URL must be the Apps Script web app URL ending in /exec",
  ),
  SHEET_BRIDGE_KEY: optionalNonEmpty,
  CLOUDINARY_CLOUD_NAME: optionalNonEmpty,
  CLOUDINARY_API_KEY: optionalNonEmpty,
  CLOUDINARY_API_SECRET: optionalNonEmpty,
  CLOUDINARY_FOLDER: z.string().regex(/^[a-z0-9_-]+$/).default("erodeglitz"),
  TOKEN_ENCRYPTION_KEY: optionalNonEmpty,

  EDITOR_GITHUB_LOGINS: loginList,
  OWNER_GITHUB_LOGIN: GitHubLoginSchema.optional(),

  POSTING_WINDOW_IST: postingWindow,
  MAX_POSTS_PER_DAY: z.coerce.number().int().min(0).max(25).default(6),
  MIN_MINUTES_BETWEEN_POSTS: z.coerce.number().int().min(5).max(24 * 60).default(30),
  APPROVAL_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /** Stories older than this many hours are not drafted or published (Coimbatore 360 lesson: stale news hurts). */
  MAX_STORY_AGE_HOURS: z.coerce.number().int().min(1).max(96).default(36),

  IG_GRAPH_VERSION: z.string().regex(/^v\d+\.\d$/).default("v26.0"),
  /** The one Instagram account this pipeline serves: the owner's existing @erodeglitz (Creator) account. */
  IG_USERNAME: z.string().regex(/^[a-z0-9._]{1,30}$/).default("erodeglitz"),
  /** Start publish.yml straight after an approval. */
  PUBLISH_ON_APPROVAL: onlyExactTrue,
  BOT_CONTACT_URL: z.url().default("https://github.com/kailash075/local-news-automation"),

  GITHUB_REPOSITORY: optionalNonEmpty,
  /** Set by GitHub Actions: "schedule" for scheduled runs. */
  GITHUB_EVENT_NAME: optionalNonEmpty,
  GITHUB_RUN_ID: z.string().default("local"),
  GITHUB_SHA: z.string().default("local"),
  GITHUB_WORKFLOW: z.string().default("local"),
});

export type Env = z.output<typeof EnvSchema>;

/**
 * GitHub Actions passes a repository variable that is not set (`${{ vars.X }}`) as an empty string, so empty and
 * blank values count as "not set": defaults apply and switches stay off.
 */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env =>
  EnvSchema.parse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== "")));

/** What is missing before a job that needs the Google Sheet can run. Empty means ready. */
export const missingForSheet = (env: Env): readonly string[] => [
  ...(env.SHEET_BRIDGE_URL === undefined ? ["SHEET_BRIDGE_URL"] : []),
  ...(env.SHEET_BRIDGE_KEY === undefined ? ["SHEET_BRIDGE_KEY"] : []),
];

/** What is missing before card images can be stored on Cloudinary. */
export const missingForImages = (env: Env): readonly string[] => [
  ...(env.CLOUDINARY_CLOUD_NAME === undefined ? ["CLOUDINARY_CLOUD_NAME"] : []),
  ...(env.CLOUDINARY_API_KEY === undefined ? ["CLOUDINARY_API_KEY"] : []),
  ...(env.CLOUDINARY_API_SECRET === undefined ? ["CLOUDINARY_API_SECRET"] : []),
];

export const createBridgeFromEnv = (env: Env): BridgeClient =>
  createBridgeClient({ url: env.SHEET_BRIDGE_URL ?? "", key: env.SHEET_BRIDGE_KEY ?? "" });

export const createImagesFromEnv = (env: Env): ObjectStore =>
  createCloudinaryObjectStore({
    cloudName: env.CLOUDINARY_CLOUD_NAME ?? "",
    apiKey: env.CLOUDINARY_API_KEY ?? "",
    apiSecret: env.CLOUDINARY_API_SECRET ?? "",
    folder: env.CLOUDINARY_FOLDER,
  });
