import { Effect } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "vitest";

import {
  cleanupErrors,
  isTransientLiveError,
  isTransientStorageStatus,
  retryLiveEffect,
} from "./live-project.ts";

function statusError(status: number): HttpClientError.HttpClientError {
  const request = HttpClientRequest.get("https://api.supabase.com/v1/projects/test");
  const response = HttpClientResponse.fromWeb(request, new Response(null, { status }));
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response }),
  });
}

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

  it("retries transient API statuses but fails authorization errors immediately", async () => {
    expect(isTransientLiveError(statusError(404))).toBe(true);
    expect(isTransientLiveError(statusError(503))).toBe(true);
    expect(isTransientLiveError(statusError(401))).toBe(false);
    expect(isTransientLiveError(statusError(403))).toBe(false);

    let attempts = 0;
    const transient = statusError(503);
    const result = await Effect.runPromise(
      retryLiveEffect(
        "storage bucket",
        Effect.suspend(() => {
          attempts += 1;
          return attempts < 3 ? Effect.fail(transient) : Effect.succeed("created");
        }),
        { interval: "1 millis", timeout: "100 millis", shouldRetry: isTransientLiveError },
      ),
    );
    expect(result).toBe("created");
    expect(attempts).toBe(3);

    attempts = 0;
    await expect(
      Effect.runPromise(
        retryLiveEffect(
          "project readiness",
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(statusError(403));
          }),
          {
            interval: "1 millis",
            timeout: "100 millis",
            shouldRetry: isTransientLiveError,
          },
        ),
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("classifies storage responses for retry without retrying terminal client errors", () => {
    expect(isTransientStorageStatus(408)).toBe(true);
    expect(isTransientStorageStatus(429)).toBe(true);
    expect(isTransientStorageStatus(500)).toBe(true);
    expect(isTransientStorageStatus(401)).toBe(false);
    expect(isTransientStorageStatus(403)).toBe(false);
    expect(isTransientStorageStatus(422)).toBe(false);
  });
});
