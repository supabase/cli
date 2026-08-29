import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  DOCKER_DEFAULT_VERSIONS,
  connectLayer,
  fillServiceVersionManifest,
  planStackVersions,
} from "@supabase/stack/effect";
import { Effect, Layer } from "effect";
import { start } from "./start.handler.ts";
import { startVersionStateLaunch, StartVersionState } from "./start.command.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { inkLayer } from "../../../shared/runtime/ink.layer.ts";
import {
  mockOutput,
  mockProcessControl,
  mockProjectLinkState,
  mockCliProjectLocalServiceVersions,
} from "../../../../tests/helpers/mocks.ts";
import { makeRunningStackFixture } from "../../../../tests/helpers/running-stack.ts";

describe("start handler", () => {
  it.live("reattaches through managed control and preserves launch selections", () =>
    Effect.scoped(
      Effect.promise(() => makeRunningStackFixture()).pipe(
        Effect.flatMap((fixture) =>
          connectLayer({
            cliVersion: fixture.cliVersion,
            cacheRoot: fixture.homeDir,
            cwd: fixture.projectRoot,
            projectDir: fixture.projectRoot,
            name: fixture.stackName,
          }).pipe(
            Effect.provide(fixture.baseLayer),
            Effect.flatMap((stackLayer) => {
              const out = mockOutput({ interactive: false });
              const versions = fillServiceVersionManifest(DOCKER_DEFAULT_VERSIONS, "docker");
              const serviceVersionContext = planStackVersions({
                runtime: "docker",
                pinnedBaseline: versions,
                candidateBaseline: versions,
              });
              const postStartLaunch = {
                ...fixture.launch,
                versions: { postgres: "17.7.0" },
                excludedServices: ["analytics", "future-service"],
              } as const;
              const state = StartVersionState.of({
                launch: startVersionStateLaunch({ launch: postStartLaunch }),
                serviceVersionContext: {
                  ...serviceVersionContext,
                  updateFingerprint: "new-fingerprint",
                },
                lifecycleInput: {
                  cacheRoot: fixture.homeDir,
                  workspacePath: fixture.projectRoot,
                  stackName: fixture.stackName,
                  cwd: fixture.projectRoot,
                  cliVersion: fixture.cliVersion,
                },
                drift: [
                  {
                    key: "api.port",
                    actualIntent: "automatic",
                    actualPort: 54321,
                    configuredPort: 54322,
                    configuredIntent: "exact",
                  },
                ],
              });
              const analytics = Layer.succeed(Analytics, {
                capture: () => Effect.void,
                identify: () => Effect.void,
                alias: () => Effect.void,
                groupIdentify: () => Effect.void,
              });
              const layer = Layer.mergeAll(
                fixture.baseLayer,
                stackLayer,
                out.layer,
                analytics,
                Layer.succeed(StartVersionState, state),
                mockProcessControl().layer,
                mockProjectLinkState(),
                mockCliProjectLocalServiceVersions(),
                BunServices.layer,
                inkLayer,
              );
              return start({
                stack: fixture.stackName,
                mode: "docker",
                exclude: [],
                serviceVersion: [],
                detach: true,
              }).pipe(
                Effect.provide(layer),
                Effect.tap(
                  Effect.promise(async () => {
                    const document = await fixture.readDocument();
                    expect(document?.launch).toMatchObject({
                      versions: { postgres: "17.7.0" },
                      excludedServices: ["analytics", "future-service"],
                      lastNotifiedUpdateFingerprint: "new-fingerprint",
                    });
                  }),
                ),
                Effect.ensuring(Effect.promise(() => fixture.dispose())),
                Effect.andThen(
                  Effect.sync(() => {
                    expect(out.messages).toContainEqual(
                      expect.objectContaining({
                        type: "info",
                        message: `API URL: ${fixture.stackInfo.url}`,
                      }),
                    );
                    expect(out.messages).toContainEqual(
                      expect.objectContaining({
                        type: "warn",
                        message: expect.stringContaining("api.port changed from 54321 to 54322"),
                      }),
                    );
                  }),
                ),
              );
            }),
          ),
        ),
      ),
    ),
  );
});
