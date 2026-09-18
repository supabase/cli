import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({ filePath: Schema.optionalKey(Schema.String) });

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("imgproxy", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "imgproxy",
  executable: "bin/imgproxy",
  ports: { http: 5001 },
  healthPath: "/health",
  env: (_creation, endpoints, container) => {
    const http = endpoints.get("http");
    return Effect.succeed({
      ...(http === undefined ? {} : { IMGPROXY_PORT: String(http.port) }),
      ...(http === undefined
        ? {}
        : { IMGPROXY_BIND: `${container ? "0.0.0.0" : "127.0.0.1"}:${http.port}` }),
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
    });
  },
  args: () => Effect.succeed([]),
  mounts: (creation) =>
    Effect.succeed(
      creation.config.filePath === undefined
        ? []
        : [{ source: creation.config.filePath, target: "/mnt", readOnly: true }],
    ),
  startup: [],
});
