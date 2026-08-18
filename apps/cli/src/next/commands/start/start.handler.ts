import { Effect } from "effect";
import { updateManagedLaunch } from "@supabase/stack/effect";
import { Output } from "../../../shared/output/output.service.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import type { StartFlags } from "./start.command.ts";
import { StartVersionState } from "./start.command.ts";
import { startBackground } from "./flows/background.flow.ts";
import { startForeground } from "./flows/foreground.flow.ts";
import { startNonInteractive } from "./flows/non-interactive.flow.ts";
import { formatPortDriftWarning } from "../../stack/port-drift.ts";

export const start = Effect.fnUntraced(function* (flags: StartFlags) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const output = yield* Output;
      const analytics = yield* Analytics;
      const startVersionState = yield* StartVersionState;
      const { launch, previousUpdateFingerprint, serviceVersionContext, lifecycleInput, drift } =
        startVersionState;

      const driftWarning = drift === undefined ? undefined : formatPortDriftWarning(drift);
      if (driftWarning !== undefined) yield* output.warn(driftWarning);

      if (serviceVersionContext.activeOverrides.length > 0) {
        yield* output.warn(
          [
            "Local service version overrides are active (at your own risk):",
            ...serviceVersionContext.activeOverrides.map(
              ({ service, version, source }) => `  ${service}: ${version} [${source}]`,
            ),
            "These overrides are local to this checkout and may break compatibility.",
          ].join("\n"),
        );
      }

      if (
        serviceVersionContext.updateFingerprint !== undefined &&
        previousUpdateFingerprint !== serviceVersionContext.updateFingerprint
      ) {
        yield* output.warn(
          [
            "Updated linked or default service versions are available for this local stack:",
            ...serviceVersionContext.availableUpdates.map(
              ({ service, pinnedVersion, availableVersion }) =>
                `  ${service}: ${pinnedVersion} -> ${availableVersion}`,
            ),
            "Run `supabase stack update` to adopt these pinned versions.",
          ].join("\n"),
        );
        yield* updateManagedLaunch({
          ...lifecycleInput,
          launch: {
            mode: launch.mode,
            versions: launch.versions,
            excludedServices: launch.excludedServices,
            lastNotifiedUpdateFingerprint: serviceVersionContext.updateFingerprint,
          },
        });
      }

      let result: void;
      if (flags.detach) {
        result = yield* startBackground();
      } else if (output.interactive) {
        result = yield* startForeground();
      } else {
        result = yield* startNonInteractive();
      }

      yield* analytics.capture("cli_stack_started", {
        mode: launch.mode,
        detach: flags.detach,
        stack: flags.stack,
      });
      return result;
    }),
  );
});
