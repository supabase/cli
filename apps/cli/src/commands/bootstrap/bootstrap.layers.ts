import { Layer } from "effect";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { httpClientLayer } from "../../auth/http-debug.layer.ts";
import { commandPlatformApiFactoryFromApiLayer } from "../../auth/command-platform-api-factory.layer.ts";
import { commandPlatformApiLayer } from "../../auth/command-platform-api.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { projectRefLayer } from "../../config/project-ref.layer.ts";
import { dbConnectionLayer } from "../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { linkedProjectCacheLayer } from "../../telemetry/linked-project-cache.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { browserLayer } from "../../shared/runtime/browser.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { loginApiLayer } from "../../command-internal/login-api.layer.ts";
import { loginCryptoLayer } from "../../command-internal/login-crypto.layer.ts";
import { templateServiceLayer } from "./bootstrap.templates.ts";

// `bootstrap` is a meta-orchestrator: it needs the full Management-API stack
// (create / api-keys / link cores), the browser-login stack (ensure-login), and
// the GitHub template service. `Layer.provide` does not share to siblings inside
// a `Layer.mergeAll` (CLAUDE.md invariant 5), so every sub-layer that requires
// `CommandSettings` / `HttpClient` / `CommandCredentials` is fed those explicitly.
// Shared sub-layers are memoised by reference so the merge reuses one keyring
// reader / one debug-logging HTTP wrapper / one config loader.
//
// `Output`, `Analytics`, `Stdio`, `Tty`, `RuntimeInfo`, `ProcessControl`, and
// `BunServices` (`FileSystem` / `Path` / `ChildProcessSpawner`) come from the root
// layer (`cli/root.ts` + `runCli`). `DebugLogger` is
// NOT provided by the root, so every base layer that reads it for `--debug` traces
// (`commandSettingsLayer`, `httpClientLayer`, `commandCredentialsLayer`,
// `commandPlatformApiLayer`) is fed `debugLoggerLayer` here — matching `login.layers.ts`.
const debugLogger = debugLoggerLayer;
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLogger));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLogger));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLogger),
);
const platformApi = commandPlatformApiLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(httpClient),
  Layer.provide(debugLogger),
  Layer.provide(identityStitchLayer),
);
const platformApiFactory = commandPlatformApiFactoryFromApiLayer.pipe(Layer.provide(platformApi));

export const bootstrapRuntimeLayer = Layer.mergeAll(
  platformApi,
  platformApiFactory,
  httpClient,
  credentials,
  cliSettings,
  projectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliSettings)),
  linkedProjectCacheLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliSettings),
    Layer.provide(httpClient),
    Layer.provide(identityStitchLayer),
  ),
  telemetryStateLayer,
  dbConnectionLayer,
  // Exposed bare (not just used to feed sibling sub-layers, as elsewhere in this
  // file) because `bootstrap.handler.ts` now calls `resolveLinkedConn`
  // (CLI-1953's IPv4-pooler-fallback push connection) directly, which reads it.
  debugLogger,
  // The one per-command identity stitcher (a single root-context `sync.Once`),
  // exposed at top level so `withCommandTelemetry` can read
  // `stitchedDistinctId()` and attribute the cli_command_executed event to the
  // gotrue id. The SAME reference is provided to platformApi / linkedProjectCache
  // above, so memoisation gives all transports one `stitchAttempted` guard —
  // aliasing/persisting at most once. Its Analytics / TelemetryRuntime /
  // FileSystem / Path deps are ambient (root runtime). Mirrors advisors.layers.ts.
  identityStitchLayer,
  loginApiLayer.pipe(Layer.provide(httpClient), Layer.provide(cliSettings)),
  loginCryptoLayer,
  templateServiceLayer.pipe(Layer.provide(httpClient)),
  browserLayer,
  stdinLayer,
  commandRuntimeLayer(["bootstrap"]),
);
