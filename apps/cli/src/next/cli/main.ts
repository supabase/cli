#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { analyticsLayer } from "../../shared/telemetry/analytics.layer.ts";
import { nextRoot } from "./root.ts";

await runCli(nextRoot, {
  analyticsLayer,
  // `next start`'s own flows (`commands/start/flows/{foreground,non-interactive}.flow.ts`)
  // already race their stack lifecycle against `interruptOnSignal` and drive their own
  // controlled shutdown (`markStopping`, a clean stop result). `run.ts`'s shared
  // `selfManagedSignalCommands` list is matched purely against argv, with no notion of which
  // shell registered the command, so it can't tell this `["start"]` apart from legacy's own
  // native `start` (which DOES need the global wrapper, for Go-parity rollback-on-interrupt).
  // Exempting it here, per shell, avoids the global wrapper racing this flow's own signal
  // handling and forcing a raw interrupt (generic exit 130) instead of the flow's own graceful
  // stop.
  additionalSelfManagedSignalCommands: [["start"]],
});
