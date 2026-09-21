import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({
  http: Schema.optionalKey(EndpointIntent),
  smtp: Schema.optionalKey(EndpointIntent),
  pop3: Schema.optionalKey(EndpointIntent),
});

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("mail", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "mail",
  executable: "bin/mailpit",
  ports: { http: 8025, smtp: 1025, pop3: 1110 },
  healthPath: "/readyz",
  env: (_creation, endpoints, container) => {
    const http = endpoints.get("http");
    const smtp = endpoints.get("smtp");
    const pop3 = endpoints.get("pop3");
    return Effect.succeed({
      ...(http === undefined
        ? {}
        : {
            MP_UI_PORT: String(http.port),
            MP_UI_BIND_ADDR: `${container ? "0.0.0.0" : "127.0.0.1"}:${http.port}`,
          }),
      ...(smtp === undefined
        ? {}
        : {
            MP_SMTP_PORT: String(smtp.port),
            MP_SMTP_BIND_ADDR: `${container ? "0.0.0.0" : "127.0.0.1"}:${smtp.port}`,
          }),
      ...(pop3 === undefined
        ? {}
        : {
            MP_POP3_PORT: String(pop3.port),
            MP_POP3_BIND_ADDR: `${container ? "0.0.0.0" : "127.0.0.1"}:${pop3.port}`,
          }),
      // Docker gateway addresses can make SMTP reverse DNS delay Auth recovery.
      MP_SMTP_DISABLE_RDNS: "true",
    });
  },
  args: () => Effect.succeed([]),
  mounts: () => Effect.succeed([]),
  startup: [],
});
