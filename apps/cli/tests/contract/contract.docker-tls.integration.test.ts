import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { containerPeer, isLoopback } from "../../../../packages/stack/tests/api-tls.ts";
import { describeContract } from "./cases.ts";
import { refusedTlsStart, stackTarget } from "./target.ts";

/* Where this host's Docker containers arrive from, measured on its own, picks the expectation. */
const peer = await Effect.runPromise(
  containerPeer({ engine: "docker", argv: [] }).pipe(Effect.provide(BunServices.layer)),
);

/* Plain HTTP on a TLS API port is for loopback peers only, so where this engine's containers
   arrive from elsewhere, start refuses api.tls instead of serving consumers. */
if (isLoopback(peer))
  describeContract("stack/container over api.tls, embedded pair", stackTarget("docker", "default"));
else
  describe(`stack/container over api.tls, embedded pair, containers from ${peer}`, () => {
    it.live(
      "fails start with unsupported networking and leaves no service running",
      () =>
        Effect.gen(function* () {
          const { message, ids, running } = yield* refusedTlsStart;
          expect(message).toContain("api.tls: unsupported networking on ");
          expect(message).toContain("; its services stopped: ");
          expect(ids).toHaveLength(1);
          expect(running).toEqual([{ code: 0, stderr: "", names: [] }]);
        }),
      300_000,
    );
  });
