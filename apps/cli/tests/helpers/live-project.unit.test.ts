import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { cleanupErrors, retryLiveEffect } from "./live-project.ts";

describe("live project lifecycle", () => {
  it("retries transient failures until the management operation succeeds", async () => {
    let attempts = 0;
    const result = await Effect.runPromise(
      retryLiveEffect(
        "project readiness",
        Effect.suspend(() =>
          Effect.sync(() => {
            attempts += 1;
            return attempts < 3
              ? Effect.fail(new Error("temporarily unavailable"))
              : Effect.succeed("ACTIVE_HEALTHY");
          }).pipe(Effect.flatten),
        ),
        { interval: "1 millis", timeout: "100 millis" },
      ),
    );

    expect(result).toBe("ACTIVE_HEALTHY");
    expect(attempts).toBe(3);
  });

  it("fails a poll when its wall-clock deadline expires", async () => {
    const result = Effect.runPromise(
      retryLiveEffect("project keys", Effect.never, {
        interval: "1 millis",
        timeout: "10 millis",
      }),
    );

    await expect(result).rejects.toThrow("project keys timed out");
  });

  it("preserves both target and cleanup failures", () => {
    const error = cleanupErrors(new Error("provision failed"), [
      new Error("profile cleanup failed"),
      new Error("project deletion failed"),
    ]);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(3);
    expect(error.errors.map((entry) => String(entry))).toEqual([
      "Error: provision failed",
      "Error: profile cleanup failed",
      "Error: project deletion failed",
    ]);
  });
});
