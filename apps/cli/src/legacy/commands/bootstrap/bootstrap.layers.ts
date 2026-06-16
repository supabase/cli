import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiFactoryFromApiLayer } from "../../auth/legacy-platform-api-factory.layer.ts";
import { legacyPlatformApiLayer } from "../../auth/legacy-platform-api.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyProjectRefLayer } from "../../config/legacy-project-ref.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyIdentityStitchLayer } from "../../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "../../telemetry/legacy-linked-project-cache.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { browserLayer } from "../../../shared/runtime/browser.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { legacyLoginApiLayer } from "../../shared/legacy-login-api.layer.ts";
import { legacyLoginCryptoLayer } from "../../shared/legacy-login-crypto.layer.ts";
import { legacyTemplateServiceLayer } from "./bootstrap.templates.ts";

// `bootstrap` is a meta-orchestrator: it needs the full Management-API stack
// (create / api-keys / link cores), the browser-login stack (ensure-login), and
// the GitHub template service. `Layer.provide` does not share to siblings inside
// a `Layer.mergeAll` (legacy CLAUDE.md item 5), so every sub-layer that requires
// `LegacyCliConfig` / `HttpClient` / `LegacyCredentials` is fed those explicitly.
// Shared sub-layers are memoised by reference so the merge reuses one keyring
// reader / one debug-logging HTTP wrapper / one config loader.
//
// `Output`, `Analytics`, `Stdio`, `Tty`, `RuntimeInfo`, `ProcessControl`,
// `LegacyGoProxy`, and `BunServices` (`FileSystem` / `Path` / `ChildProcessSpawner`)
// come from the root layer (`legacy/cli/root.ts` + `runCli`). `LegacyDebugLogger` is
// NOT provided by the root, so every base layer that reads it for `--debug` traces
// (`legacyCliConfigLayer`, `legacyHttpClientLayer`, `legacyCredentialsLayer`,
// `legacyPlatformApiLayer`) is fed `legacyDebugLoggerLayer` here — matching `login.layers.ts`.
const debugLogger = legacyDebugLoggerLayer;
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(debugLogger));
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(debugLogger));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(debugLogger),
);
const platformApi = legacyPlatformApiLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliConfig),
  Layer.provide(httpClient),
  Layer.provide(debugLogger),
  Layer.provide(legacyIdentityStitchLayer),
);
const platformApiFactory = legacyPlatformApiFactoryFromApiLayer.pipe(Layer.provide(platformApi));

export const legacyBootstrapRuntimeLayer = Layer.mergeAll(
  platformApi,
  platformApiFactory,
  httpClient,
  credentials,
  cliConfig,
  legacyProjectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliConfig)),
  legacyLinkedProjectCacheLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliConfig),
    Layer.provide(httpClient),
    Layer.provide(legacyIdentityStitchLayer),
  ),
  legacyTelemetryStateLayer,
  // The one per-command identity stitcher (Go's single root-context `sync.Once`),
  // exposed at top level so `withLegacyCommandInstrumentation` can read
  // `stitchedDistinctId()` and attribute the cli_command_executed event to the
  // gotrue id. The SAME reference is provided to platformApi / linkedProjectCache
  // above, so memoisation gives all transports one `stitchAttempted` guard —
  // aliasing/persisting at most once. Its Analytics / TelemetryRuntime /
  // FileSystem / Path deps are ambient (root runtime). Mirrors advisors.layers.ts.
  legacyIdentityStitchLayer,
  legacyLoginApiLayer.pipe(Layer.provide(httpClient), Layer.provide(cliConfig)),
  legacyLoginCryptoLayer,
  legacyTemplateServiceLayer.pipe(Layer.provide(httpClient)),
  browserLayer,
  stdinLayer,
  commandRuntimeLayer(["bootstrap"]),
);
