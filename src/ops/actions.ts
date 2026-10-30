import { appendFileSync } from "node:fs";

/** GitHub Actions helpers. Outside Actions (no GITHUB_OUTPUT / GITHUB_STEP_SUMMARY) they print instead. */

const safeValue = (value: string): string => value.replace(/[\r\n]/g, " ");

export const setOutput = (name: string, value: string | number): void => {
  const file = process.env["GITHUB_OUTPUT"];
  const line = `${name}=${safeValue(String(value))}\n`;
  if (file === undefined || file === "") console.log(`output ${line.trim()}`);
  else appendFileSync(file, line);
};

export const appendSummary = (markdown: string): void => {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file === undefined || file === "") console.log(markdown);
  else appendFileSync(file, `${markdown}\n`);
};
