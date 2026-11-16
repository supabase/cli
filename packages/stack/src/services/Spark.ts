import { Effect, Schema } from "effect";
import { EndpointIntent, hostServiceCreation } from "./Recipe.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  /** Absolute path of the `spark` binary; slim-services publishes no Spark artifact. */
  executable: Schema.String,
  /** Project directory whose `supabase/` Spark serves and stores data under. */
  projectRoot: Schema.String,
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = hostServiceCreation("spark", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

/** Spark serves `/rest/v1` and `/auth/v1` itself, keeping its data in `supabase/.temp/spark.db`. */
export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "spark",
  executable: "spark",
  hostExecutable: (creation) => creation.config.executable,
  ports: { http: 3000 },
  healthPath: "/auth/v1/health",
  env: (_creation, endpoints) =>
    Effect.sync((): Readonly<Record<string, string>> => {
      const http = endpoints.get("http");
      return http === undefined ? {} : { SPARK_API_PORT: String(http.port) };
    }),
  args: (creation) => Effect.succeed(["--workdir", creation.config.projectRoot, "start"]),
  mounts: () => Effect.succeed([]),
  startupCommands: [],
});
