import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeSpec, type Creation } from "./Realtime.ts";

const realtimeEnv = (ipVersion: Creation["config"]["ipVersion"]) =>
  makeSpec().env(
    {
      service: "realtime",
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
