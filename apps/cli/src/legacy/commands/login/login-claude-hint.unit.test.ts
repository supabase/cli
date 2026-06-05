import { describe, expect, it } from "vitest";

import { legacyIsClaudeCode, legacySuggestClaudePlugin } from "./login-claude-hint.ts";

const HINT = `<claude-code-hint v="1" type="plugin" value="supabase@claude-plugins-official" />`;

describe("legacySuggestClaudePlugin", () => {
  it("returns the hint when running inside Claude Code with a TTY stdout", () => {
    expect(legacySuggestClaudePlugin({ stdoutIsTty: true, env: { CLAUDECODE: "1" } })).toBe(HINT);
    expect(legacySuggestClaudePlugin({ stdoutIsTty: true, env: { CLAUDE_CODE: "1" } })).toBe(HINT);
  });

  it("returns empty string when stdout is not a TTY", () => {
    expect(legacySuggestClaudePlugin({ stdoutIsTty: false, env: { CLAUDECODE: "1" } })).toBe("");
  });

  it("returns empty string when not running inside Claude Code", () => {
    expect(legacySuggestClaudePlugin({ stdoutIsTty: true, env: {} })).toBe("");
    expect(legacySuggestClaudePlugin({ stdoutIsTty: true, env: { CLAUDECODE: "" } })).toBe("");
  });
});

describe("legacyIsClaudeCode", () => {
  it("detects CLAUDECODE / CLAUDE_CODE env presence", () => {
    expect(legacyIsClaudeCode({ CLAUDECODE: "1" })).toBe(true);
    expect(legacyIsClaudeCode({ CLAUDE_CODE: "yes" })).toBe(true);
    expect(legacyIsClaudeCode({})).toBe(false);
    expect(legacyIsClaudeCode({ CLAUDECODE: "" })).toBe(false);
  });
});
