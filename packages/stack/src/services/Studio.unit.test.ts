import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeSpec, type Creation } from "./Studio.ts";

const creation = (config: Creation["config"]): Creation => ({ service: "studio", config });

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
