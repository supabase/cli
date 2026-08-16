import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createStack, type StackHandle } from "./createStack.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { platformFactory } from "./platform-node.ts";

const handles: StackHandle[] = [];

const isAddressInUse = (error: unknown, depth = 0): boolean => {
  if (depth > 4 || !(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    if (Reflect.get(cause, "code") === "EADDRINUSE") return true;
  }
  return isAddressInUse(cause, depth + 1);
};

const freshPortPair = async (): Promise<readonly [number, number]> =>
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
          return [apiPort, dbPort] as const;
        }),
      ),
    ),
  );

/** Transfer a fresh exact pair into public createStack across a bounded bind handoff retry. */
const createStackWithFreshPorts = async (
  config: Parameters<typeof createStack>[0],
  platform: Parameters<typeof createStack>[1],
): Promise<Awaited<ReturnType<typeof createStack>>> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [apiPort, dbPort] = await freshPortPair();
    try {
      return await createStack(
        {
          ...config,
          port: apiPort,
          postgres: { ...config?.postgres, port: dbPort },
        },
        platform,
      );
    } catch (error) {
      if (!isAddressInUse(error) || attempt === 2) throw error;
    }
  }
  throw new Error("Direct stack bind handoff exhausted retries");
};

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
});

describe("direct createStack port ownership", () => {
  it("allocates only active service fields without managed state", async () => {
    const stack = await createStackWithFreshPorts(
      {
        mode: "native",
        startupMode: "lazy",
        postgrest: false,
        auth: false,
        edgeRuntime: false,
        realtime: false,
        storage: false,
        imgproxy: false,
        mailpit: false,
        pgmeta: false,
        studio: false,
        analytics: false,
        vector: false,
        pooler: false,
      },
      platformFactory,
    );
    handles.push(stack);

    expect(stack.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stack.dbUrl).toMatch(/127\.0\.0\.1:\d+/);
    const activeServices = new Set((await stack.getStatus()).map((state) => state.name));
    expect(activeServices).not.toContain("studio");
    expect(activeServices).not.toContain("analytics");
    expect(activeServices).not.toContain("pooler");
  });
});
