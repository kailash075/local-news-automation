/** Defence in depth for anything written to the errors and publish_attempts tabs: strip credentials, cap the length. */

const SECRET_NAMES = "access_token|client_secret|refresh_token|password|apikey|api_key|api_secret|signature|key|authorization";

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [new RegExp(`\\b(${SECRET_NAMES})=([^&\\s"']+)`, "gi"), "$1=[REDACTED]"],
  [new RegExp(`("(?:${SECRET_NAMES})"\\s*:\\s*")[^"]*"`, "gi"), '$1[REDACTED]"'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  // Instagram user access tokens (Instagram Login) start with "IG".
  [/\bIG[A-Za-z0-9_-]{30,}/g, "[REDACTED]"],
  // Apps Script web app URLs carry the deployment id.
  [/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+/g, "https://script.google.com/macros/s/[REDACTED]"],
];

export const redact = (text: string, maxLength = 2000): string => {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
};
