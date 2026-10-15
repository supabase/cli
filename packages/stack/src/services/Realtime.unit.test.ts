import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ServiceEndpoint } from "./Recipe.ts";
import { makeSpec, type Creation } from "./Realtime.ts";
import { selection } from "../../tests/pins.ts";

const realtimeEnv = (ipVersion: Creation["config"]["ipVersion"]) =>
  makeSpec().env(
    {
      service: "realtime",
      pin: selection.realtime,
      config: {
        databaseUrl: "postgresql://supabase_admin:postgres@host.docker.internal:54322/postgres",
        ...(ipVersion === undefined ? {} : { ipVersion }),
      },
    },
    new Map(),
    true,
  );

it.effect("connects to the database over IPv4 whichever family Realtime binds", () =>
  Effect.gen(function* () {
    expect(yield* realtimeEnv(undefined)).toMatchObject({
      DB_IP_VERSION: "ipv4",
      ERL_AFLAGS: "-proto_dist inet_tcp",
    });
    expect(yield* realtimeEnv("IPv6")).toMatchObject({
      DB_IP_VERSION: "ipv4",
      ERL_AFLAGS: "-proto_dist inet6_tcp",
    });
  }),
);

it.effect("requires the selected HTTP port on a successful native endpoint bind line", () =>
  Effect.sync(() => {
    const readinessOutput = makeSpec().nativeReadinessOutput;
    const endpoints: ReadonlyMap<string, ServiceEndpoint> = new Map([
      ["http", { kind: "tcp" as const, host: "127.0.0.1", port: 4000 }],
    ]);

    expect(
      readinessOutput?.(
        "Running RealtimeWeb.Endpoint with cowboy 2.18.0 at 127.0.0.1:4000 (http)",
        endpoints,
      ),
    ).toBe(true);
    expect(
      readinessOutput?.(
        "Failed to start Ranch listener RealtimeWeb.Endpoint.HTTP in :ranch_tcp:listen([ip: {127, 0, 0, 1}, port: 4000]) for reason :eaddrinuse (address already in use)",
        endpoints,
      ),
    ).toBe(false);
    expect(
      readinessOutput?.(
        "Running RealtimeWeb.Endpoint with cowboy 2.18.0 at 127.0.0.1:40001 (http)",
        endpoints,
      ),
    ).toBe(false);
  }),
);
