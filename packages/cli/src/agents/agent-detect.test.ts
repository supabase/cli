import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn<(path: string) => boolean>().mockReturnValue(false);
const FAKE_HOME = "/fake/home";

vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));

// Import after mocks are set up (vi.mock is hoisted)
const { detectAgents } = await import("./agent-detect.ts");

describe("detectAgents", () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(false);
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("returns empty array when no agents are detected", () => {
    expect(detectAgents()).toEqual([]);
  });

  it("detects Claude Code when ~/.claude exists", () => {
    existsSyncMock.mockImplementation((path: string) => path === `${FAKE_HOME}/.claude`);
    const result = detectAgents();
    expect(result).toEqual([{ displayName: "Claude Code", skillsDir: ".claude/skills" }]);
  });

  it("detects Cursor when ~/.cursor exists", () => {
    existsSyncMock.mockImplementation((path: string) => path === `${FAKE_HOME}/.cursor`);
    const result = detectAgents();
    expect(result).toEqual([{ displayName: "Cursor", skillsDir: ".agents/skills" }]);
  });

  it("detects Windsurf when ~/.codeium/windsurf exists", () => {
    existsSyncMock.mockImplementation((path: string) => path === `${FAKE_HOME}/.codeium/windsurf`);
    const result = detectAgents();
    expect(result).toEqual([{ displayName: "Windsurf", skillsDir: ".windsurf/skills" }]);
  });

  it("detects Amp via XDG config home", () => {
    existsSyncMock.mockImplementation((path: string) => path === `${FAKE_HOME}/.config/amp`);
    const result = detectAgents();
    expect(result).toEqual([{ displayName: "Amp", skillsDir: ".agents/skills" }]);
  });

  it("detects multiple agents when their config dirs exist", () => {
    existsSyncMock.mockImplementation(
      (path: string) =>
        path === `${FAKE_HOME}/.claude` ||
        path === `${FAKE_HOME}/.codeium/windsurf` ||
        path === `${FAKE_HOME}/.roo`,
    );
    const result = detectAgents();
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.displayName)).toEqual(["Claude Code", "Roo Code", "Windsurf"]);
  });

  it("deduplicates agents sharing the same skillsDir", () => {
    // Amp, Cursor, Codex, Gemini CLI all use .agents/skills
    existsSyncMock.mockImplementation(
      (path: string) =>
        path === `${FAKE_HOME}/.config/amp` ||
        path === `${FAKE_HOME}/.cursor` ||
        path === `${FAKE_HOME}/.codex` ||
        path === `${FAKE_HOME}/.gemini`,
    );
    const result = detectAgents();
    // Should only have one entry for .agents/skills (first match: Amp)
    const agentSkillsEntries = result.filter((a) => a.skillsDir === ".agents/skills");
    expect(agentSkillsEntries).toHaveLength(1);
    expect(agentSkillsEntries[0]!.displayName).toBe("Amp");
  });
});
