import { describe, expect, it } from "vitest";
import { ServiceState } from "@supabase/process-compose";
import { fromRawServiceState } from "./StackServiceState.ts";

describe("fromRawServiceState", () => {
  it("preserves terminal health-failure state semantics", () => {
    const projected = fromRawServiceState(
      new ServiceState({
        name: "edge-runtime",
        status: "Failed",
        pid: null,
        exitCode: null,
        restartCount: 2,
        startedAt: 1_000,
        error: "Health check failed and restart budget was exhausted",
        desired: "running",
      }),
    );

    expect(projected).toMatchObject({
      status: "Failed",
      pid: null,
      exitCode: null,
      error: "Health check failed and restart budget was exhausted",
    });
  });
});
