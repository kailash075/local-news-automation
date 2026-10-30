import { err, ok, type Result } from "../lib/result.ts";
import { SHORT_HASH_LENGTH } from "./revision-hash.ts";

/**
 * Slash commands in review-issue comments. The comment body is untrusted input: it is length-capped,
 * parsed with fixed patterns only, and never interpolated into a shell or evaluated.
 */

export type ClockTime = { hour: number; minute: number };

export type ReviewCommand =
  | { kind: "caption"; text: string }
  | { kind: "headline"; text: string }
  | { kind: "approve"; rev: string }
  | { kind: "approve_sensitive"; rev: string }
  | { kind: "schedule"; rev: string; time: ClockTime }
  | { kind: "attest"; method: string }
  | { kind: "hold"; reason: string }
  | { kind: "unhold" }
  | { kind: "reject"; reason: string }
  | { kind: "retract"; reason: string }
  | { kind: "killswitch_on"; reason: string }
  | { kind: "killswitch_off" };

export type CommandParseError =
  | { kind: "not_a_command" }
  | { kind: "too_long"; maxChars: number }
  | { kind: "unknown_command"; name: string }
  | { kind: "invalid_arguments"; command: string; message: string };

export const MAX_COMMENT_CHARS = 5000;
export const MAX_CAPTION_CHARS = 2200;
export const MAX_HEADLINE_CHARS = 120;
export const MAX_REASON_CHARS = 500;
const MIN_REASON_CHARS = 3;
const MIN_ATTEST_CHARS = 10;

const REV_PATTERN = new RegExp(`^[0-9a-f]{${SHORT_HASH_LENGTH}}$`);
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const COMMAND_PATTERN = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/;

// Removes C0 control characters except tab and newline, and DEL. Carriage returns are normalised first.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const parseCommand = (body: string): Result<ReviewCommand, CommandParseError> => {
  if (body.length > MAX_COMMENT_CHARS) return err({ kind: "too_long", maxChars: MAX_COMMENT_CHARS });
  const clean = body.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").trim();
  const newline = clean.indexOf("\n");
  const firstLine = (newline === -1 ? clean : clean.slice(0, newline)).trim();
  const restLines = newline === -1 ? "" : clean.slice(newline + 1).trim();

  const match = COMMAND_PATTERN.exec(firstLine);
  if (match === null) return err({ kind: "not_a_command" });
  const name = match[1] ?? "";
  const firstLineArgs = (match[2] ?? "").trim();
  const tokens = firstLineArgs === "" ? [] : firstLineArgs.split(/\s+/);
  /** Free text: the rest of the first line plus every following line. */
  const freeText = [firstLineArgs, restLines].filter((s) => s !== "").join("\n").trim();

  const invalid = (message: string): Result<ReviewCommand, CommandParseError> =>
    err({ kind: "invalid_arguments", command: name, message });

  switch (name) {
    case "caption":
      if (freeText === "") return invalid("write the new caption after /caption");
      if (freeText.length > MAX_CAPTION_CHARS) return invalid(`caption is longer than ${MAX_CAPTION_CHARS} characters`);
      return ok({ kind: "caption", text: freeText });

    case "headline": {
      if (restLines !== "") return invalid("the headline must be on one line");
      if (firstLineArgs === "") return invalid("write the new headline after /headline");
      if (firstLineArgs.length > MAX_HEADLINE_CHARS) return invalid(`headline is longer than ${MAX_HEADLINE_CHARS} characters`);
      return ok({ kind: "headline", text: firstLineArgs });
    }

    case "approve":
    case "approve-sensitive": {
      if (tokens.length !== 1 || restLines !== "") return invalid(`use: /${name} <first ${SHORT_HASH_LENGTH} characters of the revision hash>`);
      const rev = (tokens[0] ?? "").toLowerCase();
      if (!REV_PATTERN.test(rev)) return invalid(`the revision must be ${SHORT_HASH_LENGTH} hexadecimal characters`);
      return ok(name === "approve" ? { kind: "approve", rev } : { kind: "approve_sensitive", rev });
    }

    case "schedule": {
      if (tokens.length !== 2 || restLines !== "") return invalid("use: /schedule <revision> <HH:MM IST>");
      const rev = (tokens[0] ?? "").toLowerCase();
      if (!REV_PATTERN.test(rev)) return invalid(`the revision must be ${SHORT_HASH_LENGTH} hexadecimal characters`);
      const time = TIME_PATTERN.exec(tokens[1] ?? "");
      if (time === null) return invalid("the time must be HH:MM in 24-hour IST, for example 18:30");
      return ok({ kind: "schedule", rev, time: { hour: Number(time[1]), minute: Number(time[2]) } });
    }

    case "attest":
      if (freeText.length < MIN_ATTEST_CHARS) return invalid("say how you verified the facts, for example who you called and when");
      if (freeText.length > MAX_REASON_CHARS) return invalid(`keep it under ${MAX_REASON_CHARS} characters`);
      return ok({ kind: "attest", method: freeText });

    case "hold":
    case "reject":
    case "retract": {
      const reason = reasonOf(freeText);
      if (reason === undefined) return invalid(`give a reason (${MIN_REASON_CHARS} to ${MAX_REASON_CHARS} characters)`);
      return ok({ kind: name, reason });
    }

    case "unhold":
      if (freeText !== "") return invalid("/unhold takes no arguments");
      return ok({ kind: "unhold" });

    case "killswitch": {
      const [mode, ...rest] = tokens;
      if (mode === "off") {
        if (rest.length > 0 || restLines !== "") return invalid("/killswitch off takes no other arguments");
        return ok({ kind: "killswitch_off" });
      }
      if (mode === "on") {
        const reason = reasonOf([rest.join(" "), restLines].filter((s) => s !== "").join("\n"));
        if (reason === undefined) return invalid("use: /killswitch on <reason>");
        return ok({ kind: "killswitch_on", reason });
      }
      return invalid("use: /killswitch on <reason> or /killswitch off");
    }

    default:
      return err({ kind: "unknown_command", name });
  }
};

const reasonOf = (text: string): string | undefined => {
  const reason = text.trim();
  return reason.length >= MIN_REASON_CHARS && reason.length <= MAX_REASON_CHARS ? reason : undefined;
};

export const describeParseError = (e: CommandParseError): string => {
  switch (e.kind) {
    case "not_a_command":
      return "This comment is not a command.";
    case "too_long":
      return `The comment is longer than ${e.maxChars} characters.`;
    case "unknown_command":
      return `Unknown command /${e.name}.`;
    case "invalid_arguments":
      return `/${e.command}: ${e.message}.`;
  }
};
