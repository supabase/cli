import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { provideProjectCommandRuntime } from "../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { services } from "./services.handler.ts";

const servicesRuntimeLayer = provideProjectCommandRuntime(
  Layer.mergeAll(
    credentialsLayer,
    projectLinkStateLayer,
    commandRuntimeLayer(["services"]),
    // `fetchLinkedServiceVersions` builds its management/tenant API clients from
    // the ambient HttpClient rather than self-provisioning one.
    FetchHttpClient.layer,
  ),
);

export const servicesCommand = Command.make("services").pipe(
  Command.withDescription(
    "Show versions of local Supabase services.\n\nPrints the local image matrix and, when this checkout is linked and authenticated, best-effort linked service versions for comparison.",
  ),
  Command.withShortDescription("Show versions of all Supabase services"),
  Command.withHandler(() => services().pipe(withCommandInstrumentation(), withJsonErrorHandling)),
  Command.provide(servicesRuntimeLayer),
);
