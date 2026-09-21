import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  analyticsUrl: Schema.String,
  apiKey: Schema.optionalKey(Schema.String),
  configPath: Schema.optionalKey(Schema.String),
});
export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });
export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("vector", Config, Endpoints);
export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "vector",
  executable: "bin/vector",
  ports: { http: 9001 },
  healthPath: "/health",
  env: (creation, endpoints, container) => {
    const http = endpoints.get("http");
    return Effect.succeed({
      ...(http === undefined
        ? {}
        : {
            VECTOR_API_ADDRESS: `${container ? "0.0.0.0" : "127.0.0.1"}:${http.port}`,
            VECTOR_API_PORT: String(http.port),
          }),
      LOGFLARE_URL: creation.config.analyticsUrl,
      ...(creation.config.apiKey === undefined
        ? {}
        : { LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey }),
    });
  },
  args: (creation, _endpoints, context) => {
    if (context.container && creation.config.configPath !== undefined)
      return Effect.succeed(["--config", "/etc/vector/vector.yaml"]);
    if (!context.container) {
      const configPath =
        creation.config.configPath ??
        (context.artifactRoot === undefined
          ? "share/doc/vector/config/vector.yaml"
          : `${context.artifactRoot}/share/doc/vector/config/vector.yaml`);
      return Effect.succeed(["--config", configPath]);
    }
    return Effect.succeed([]);
  },
  mounts: (creation) =>
    Effect.succeed(
      creation.config.configPath === undefined
        ? []
        : [
            {
              source: creation.config.configPath,
              target: "/etc/vector/vector.yaml",
              readOnly: true,
            },
          ],
    ),
  startup: [],
});
