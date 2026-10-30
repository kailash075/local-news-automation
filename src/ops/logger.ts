/**
 * Structured logging with redaction. Secrets must never reach logs, issue comments or the Sheet:
 * known secret keys are masked wherever they appear, and known secret values are replaced in every string.
 */

const SECRET_KEY = /^(access_?token|authorization|apikey|api_key|password|secret|token|auth|sheet_bridge_url|sheet_bridge_key|cloudinary_api_key|cloudinary_api_secret|api_secret|token_encryption_key|client_secret|ig_bootstrap_token)$/i;

const secretValues = new Set<string>();

/** Registers a secret value (for example the Instagram token) so it is masked in any later log line. */
export const registerSecret = (value: string | undefined): void => {
  if (value !== undefined && value.length >= 8) secretValues.add(value);
};

const maskString = (text: string): string => {
  let out = text;
  for (const secret of secretValues) out = out.split(secret).join("[REDACTED]");
  // access_token in any URL query string
  return out.replace(/([?&](?:access_token|client_secret|code)=)[^&\s"']+/gi, "$1[REDACTED]");
};

export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: maskString(value.message) };
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    return out;
  }
  return value;
};

type Level = "info" | "warn" | "error";

const write = (level: Level, message: string, fields?: Readonly<Record<string, unknown>>): void => {
  const line = JSON.stringify({ level, message: maskString(message), ...(fields === undefined ? {} : (redact(fields) as object)) });
  if (level === "info") console.log(line);
  else console.error(line);
};

export const log = {
  info: (message: string, fields?: Readonly<Record<string, unknown>>): void => {
    write("info", message, fields);
  },
  warn: (message: string, fields?: Readonly<Record<string, unknown>>): void => {
    write("warn", message, fields);
  },
  error: (message: string, fields?: Readonly<Record<string, unknown>>): void => {
    write("error", message, fields);
  },
};
