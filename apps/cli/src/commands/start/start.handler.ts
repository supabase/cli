import { Effect } from "effect";
import { StateManager, stackMetadata } from "@supabase/stack/effect";
import { Output } from "../../output/output.service.ts";
import { Analytics } from "../../telemetry/analytics.service.ts";
import type { StartFlags } from "./start.command.ts";
import { StartVersionState } from "./start.command.ts";
import { startBackground } from "./flows/background.flow.ts";
import { startForeground } from "./flows/foreground.flow.ts";
import { startNonInteractive } from "./flows/non-interactive.flow.ts";

export const start = Effect.fnUntraced(function* (flags: StartFlags) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const output = yield* Output;
      const analytics = yield* Analytics;
      const stateManager = yield* StateManager;
      const startVersionState = yield* StartVersionState;
      const { metadata, serviceVersionContext } = startVersionState;

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
        metadata.lastNotifiedUpdateFingerprint !== serviceVersionContext.updateFingerprint
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
        yield* stateManager.writeMetadata(
          flags.stack,
          stackMetadata({
            ports: metadata.ports,
            services: metadata.services,
            updatedAt: metadata.updatedAt,
            lastNotifiedUpdateFingerprint: serviceVersionContext.updateFingerprint,
          }),
        );
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
        mode: flags.mode,
        detach: flags.detach,
        stack: flags.stack,
      });
      return result;
    }),
  );
});
