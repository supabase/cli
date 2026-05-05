import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { Output } from "../../../shared/output/output.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { writePlatformJsonStdout } from "./platform-output.ts";
import {
  listPlatformRouteDescriptors,
  platformRouteGroupChoices,
  renderPlatformRouteDescriptors,
} from "./platform-routes.ts";
import type { PlatformHttpMethod } from "./platform-types.ts";

const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

const flags = {
  group: Flag.choice("group", platformRouteGroupChoices).pipe(
    Flag.withDescription("Filter routes to one route group."),
    Flag.optional,
  ),
  method: Flag.choice("method", API_METHODS).pipe(
    Flag.withDescription("Filter routes to those supporting a specific HTTP method."),
    Flag.optional,
  ),
  search: Flag.string("search").pipe(
    Flag.withDescription("Filter routes by path, group, or method summary text."),
    Flag.optional,
  ),
} as const;

export const apiRoutesCommand = Command.make("routes", flags).pipe(
  Command.withDescription(
    "Browse available Management API routes.\n\n" +
      "Use `supabase api request <route>` to inspect or run a route after choosing one.",
  ),
  Command.withShortDescription("Browse available API routes"),
  Command.withExamples([
    {
      command: "supabase api routes",
      description: "Browse all routes",
    },
    {
      command: "supabase api routes --group projects",
      description: "Show only routes in one group",
    },
    {
      command: "supabase api routes --search auth",
      description: "Show only auth-related routes",
    },
    {
      command: "supabase api routes --method PATCH",
      description: "Show only PATCH routes",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const routes = listPlatformRouteDescriptors({
        group: Option.getOrUndefined(flags.group),
        method: Option.getOrUndefined(flags.method) as PlatformHttpMethod | undefined,
        search: Option.getOrUndefined(flags.search),
      });

      if (output.format === "text") {
        if (routes.length === 0) {
          yield* output.info("No API routes matched the current filters.");
          return;
        }

        yield* output.info(renderPlatformRouteDescriptors(routes));
        return;
      }

      if (output.format === "json") {
        return yield* writePlatformJsonStdout(routes);
      }

      yield* output.success("", { routes });
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["api", "routes"])),
);
