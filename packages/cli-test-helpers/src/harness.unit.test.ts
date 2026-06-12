import { describe, expect, it } from "vitest";
import { createSubprocessBaseEnv } from "./harness.ts";

describe("createSubprocessBaseEnv", () => {
  it("removes inherited agent-detection environment variables", () => {
    expect(
      createSubprocessBaseEnv({
        PATH: "/usr/bin",
        AI_AGENT: "github-copilot-cli",
        CLAUDECODE: "1",
        CODEX_THREAD_ID: "thread",
        CURSOR_TRACE_ID: "trace",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("drops undefined values from the subprocess environment", () => {
    expect(
      createSubprocessBaseEnv({
        PATH: "/usr/bin",
        SUPABASE_ACCESS_TOKEN: undefined,
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});
