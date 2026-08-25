import { Cause, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { ControlTransport, ControlTransportError } from "./managed/control.ts";

const isBun = typeof Bun !== "undefined";

describe("Bun control transport", () => {
  (isBun ? test : test.skip)("classifies an owner status timeout as transport", async () => {
    const { controlTransportLayer } = await import("./platform-bun.ts");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      const port = server.port;
      expect(port).toBeTypeOf("number");
      if (port === undefined) return;
      const endpoint = {
        hostname: "127.0.0.1",
        port,
        url: `http://127.0.0.1:${port}`,
      };
      const exit = await Effect.runPromise(
        Effect.flatMap(ControlTransport, (transport) => transport.read(endpoint)).pipe(
          Effect.provide(controlTransportLayer),
          Effect.exit,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause);
        expect(failure).toBeInstanceOf(ControlTransportError);
        if (failure instanceof ControlTransportError) expect(failure.reason).toBe("transport");
      }
    } finally {
      await server.stop(true);
    }
  });
});
