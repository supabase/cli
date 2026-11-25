import { Context } from "effect";
import type { TelemetryIdentity } from "./identity.ts";
import type { ConsentState, TelemetryOptOutVariable } from "./types.ts";

interface TelemetryRuntimeShape {
  readonly configDir: string;
  readonly consent: ConsentState;
  /** The environment variable that opted this run out, when one did. */
  readonly optOutVariable?: TelemetryOptOutVariable | undefined;
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
