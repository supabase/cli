import { Context } from "effect";
import type { TelemetryIdentity } from "./identity.ts";
import type { ConsentState } from "./types.ts";

interface TelemetryRuntimeShape {
  readonly configDir: string;
  readonly tracesDir: string;
  readonly consent: ConsentState;
  readonly showDebug: boolean;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly identity: TelemetryIdentity;
  readonly isFirstRun: boolean;
  readonly isTty: boolean;
  readonly isCi: boolean;
  readonly os: string;
  readonly arch: string;
  readonly cliVersion: string;
}

export class TelemetryRuntime extends Context.Service<TelemetryRuntime, TelemetryRuntimeShape>()(
  "supabase/telemetry/TelemetryRuntime",
) {}
