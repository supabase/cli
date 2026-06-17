import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// config push uploads the local config.toml to the project (workflows 1-3). It
// confirms via a prompt, so --yes is required in the non-TTY harness. Benign on
// the throwaway project.
describe("config push (live)", () => {
  testLive("pushes the local config to the remote project", async ({ run, projectRef }) => {
    const res = await run(["config", "push", "--project-ref", projectRef, "--yes"]);
    expect(res.exitCode, res.stderr).toBe(0);
  });
});
