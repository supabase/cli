import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { DEFAULT_LOCAL_S3_ACCESS_KEY_ID, DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY } from "../Defaults.ts";
import { makeSpec, type Creation } from "./Studio.ts";
import { selection } from "../../tests/pins.ts";

const creation = (config: Creation["config"]): Creation => ({
  service: "studio",
  pin: selection.studio,
  config,
});

it.effect("points Studio's pg-meta connection at the bound database as the postgres role", () =>
  Effect.gen(function* () {
    const env = yield* makeSpec().env(
      creation({
        databaseUrl:
          "postgresql://supabase_admin:managed-secret@host.docker.internal:54329/postgres",
      }),
      new Map(),
      true,
    );
    expect(env).toMatchObject({
      POSTGRES_HOST: "host.docker.internal",
      POSTGRES_PORT: "54329",
      POSTGRES_DB: "postgres",
      POSTGRES_PASSWORD: "managed-secret",
      POSTGRES_USER_READ_WRITE: "postgres",
    });
  }),
);

it.effect("mounts the snippets folder read-write and names it per runtime", () =>
  Effect.gen(function* () {
    const spec = makeSpec();
    const config = creation({ snippetsRoot: "/project/supabase/snippets" });
    const containerEnv = yield* spec.env(config, new Map(), true);
    const nativeEnv = yield* spec.env(config, new Map(), false);
    expect(containerEnv.SNIPPETS_MANAGEMENT_FOLDER).toBe("/__supabase_snippets");
    expect(nativeEnv.SNIPPETS_MANAGEMENT_FOLDER).toBe("/project/supabase/snippets");
    expect(yield* spec.mounts(config, { container: true })).toEqual([
      { source: "/project/supabase/snippets", target: "/__supabase_snippets", readOnly: false },
    ]);
  }),
);

it.effect("gives Studio the local S3 protocol keys that Storage accepts", () =>
  Effect.gen(function* () {
    const env = yield* makeSpec().env(creation({}), new Map(), false);
    expect(env).toMatchObject({
      S3_PROTOCOL_ACCESS_KEY_ID: DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
      S3_PROTOCOL_ACCESS_KEY_SECRET: DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
    });
  }),
);

it.effect("gives Studio its Logs pages only when analytics is bound", () =>
  Effect.gen(function* () {
    const spec = makeSpec();
    const analyticsEnv = yield* spec.env(
      creation({ analyticsUrl: "http://127.0.0.1:4000", analyticsApiKey: "api-key" }),
      new Map(),
      false,
    );
    const keyOnlyEnv = yield* spec.env(creation({ analyticsApiKey: "api-key" }), new Map(), false);
    const noAnalyticsEnv = yield* spec.env(creation({}), new Map(), false);
    expect(analyticsEnv.ENABLED_FEATURES_LOGS_ALL).toBe("true");
    expect(keyOnlyEnv.ENABLED_FEATURES_LOGS_ALL).toBe("false");
    expect(noAnalyticsEnv.ENABLED_FEATURES_LOGS_ALL).toBe("false");
  }),
);
