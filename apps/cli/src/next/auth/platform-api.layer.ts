import { Effect, Layer, Option } from "effect";
import { makeApiClient } from "@supabase/api/effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../../shared/runtime/command-runtime.service.ts";
import { CliConfig } from "../config/cli-config.service.ts";
import { PlatformAuthRequiredError } from "./errors.ts";
import { Credentials } from "./credentials.service.ts";
import { PlatformApi } from "./platform-api.service.ts";

export const makePlatformApiServices = Effect.gen(function* () {
  const cliConfig = yield* CliConfig;
  const credentials = yield* Credentials;
  const commandRuntime = yield* CommandRuntime;

  const configuredToken = cliConfig.accessToken;
  const storedToken = yield* credentials.getAccessToken;
  const token = Option.isSome(configuredToken) ? configuredToken : storedToken;

  if (Option.isNone(token)) {
    return yield* Effect.fail(
      new PlatformAuthRequiredError({
        message: "You are not logged in to Supabase.",
        detail: "Platform commands require a management API access token.",
        suggestion: "Run `supabase login` or set SUPABASE_ACCESS_TOKEN before retrying.",
      }),
    );
  }

  const config = {
    baseUrl: cliConfig.apiUrl,
    accessToken: token.value,
    userAgent: "supabase",
    headers: {
      "X-Supabase-Command": getCommandRuntimeCommand(commandRuntime),
      "X-Supabase-Command-Run-ID": commandRuntime.commandRunId,
    },
  };

  const api = yield* makeApiClient(config);
  return Layer.succeed(PlatformApi, api);
});

export const platformApiLayer = Layer.unwrap(makePlatformApiServices).pipe(
  Layer.provide(FetchHttpClient.layer),
);
