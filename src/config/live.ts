import { existsSync } from "node:fs";

const REPOSITORY_ROOT = new URL("../../", import.meta.url);

/**
 * Coimbatore 360's go-live switch: real posts happen only while a file named LIVE is in the repository root.
 * The owner adds it with a commit; nothing in the pipeline creates or removes it.
 */
export const liveFileExists = (root: URL = REPOSITORY_ROOT): boolean => existsSync(new URL("LIVE", root));
