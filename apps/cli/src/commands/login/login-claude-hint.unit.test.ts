import { describe, expect, it } from "vitest";

import { isClaudeCode, suggestClaudePlugin } from "./login-claude-hint.ts";

const HINT = `<claude-code-hint v="1" type="plugin" value="supabase@claude-plugins-official" />`;

describe("suggestClaudePlugin", () => {
  it("returns the hint when running inside Claude Code with a TTY stdout", () => {
    expect(suggestClaudePlugin({ stdoutIsTty: true, env: { CLAUDECODE: "1" } })).toBe(HINT);
    expect(suggestClaudePlugin({ stdoutIsTty: true, env: { CLAUDE_CODE: "1" } })).toBe(HINT);
  });

  it("returns empty string when stdout is not a TTY", () => {
    expect(suggestClaudePlugin({ stdoutIsTty: false, env: { CLAUDECODE: "1" } })).toBe("");
  });

  it("returns empty string when not running inside Claude Code", () => {
    expect(suggestClaudePlugin({ stdoutIsTty: true, env: {} })).toBe("");
    expect(suggestClaudePlugin({ stdoutIsTty: true, env: { CLAUDECODE: "" } })).toBe("");
  });
});

describe("isClaudeCode", () => {
  it("detects CLAUDECODE / CLAUDE_CODE env presence", () => {
    expect(isClaudeCode({ CLAUDECODE: "1" })).toBe(true);
    expect(isClaudeCode({ CLAUDE_CODE: "yes" })).toBe(true);
    expect(isClaudeCode({})).toBe(false);
    expect(isClaudeCode({ CLAUDECODE: "" })).toBe(false);
  });
});
