// oxlint-disable effecttsgo/async-function -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { createStack, type StackHandle } from "../../src/node.ts";
import { reservePortSet } from "../../src/PortAllocator.ts";
import type { StackConfig } from "../../src/StackConfig.ts";

interface EphemeralStackPorts {
  readonly apiPort: number;
  readonly dbPort: number;
}

const isAddressInUse = (error: unknown, depth = 0): boolean => {
  if (depth > 4 || !(error instanceof Error)) return false;
  if ("code" in error && Reflect.get(error, "code") === "EADDRINUSE") return true;
  const cause: unknown = error.cause;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    if (Reflect.get(cause, "code") === "EADDRINUSE") return true;
  }
  return isAddressInUse(cause, depth + 1);
};

const reserveEphemeralStackPorts = async (): Promise<EphemeralStackPorts> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.acquireRelease(
        reservePortSet([
          { field: "apiPort", selection: { kind: "automatic" } },
          { field: "dbPort", selection: { kind: "automatic" } },
        ]),
        (lease) => lease.releaseAll,
      ).pipe(
        Effect.map((lease) => {
          const apiPort = lease.ports.apiPort;
          const dbPort = lease.ports.dbPort;
          if (apiPort === undefined || dbPort === undefined) {
            throw new Error("Ephemeral port reservation returned an incomplete pair");
          }
          return { apiPort, dbPort };
        }),
      ),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

/**
 * Create a stack with an OS-selected API/Postgres pair.
 *
 * Port leases are released immediately before createStack binds its listeners. A
 * short retry closes that unavoidable handoff race without serializing e2e files.
 */
export async function createStackWithEphemeralPorts(
  config: StackConfig = {},
): Promise<StackHandle> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ports = await reserveEphemeralStackPorts();
    try {
      const stack = await createStack({
        ...config,
        port: ports.apiPort,
        postgres: { ...config.postgres, port: ports.dbPort },
      });
      return stack;
    } catch (error) {
      if (!isAddressInUse(error) || attempt === 2) throw error;
    }
  }
  throw new Error("Ephemeral stack port handoff exhausted retries");
}
