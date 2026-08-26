import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { status } from "./status.handler.ts";
import {
  mockOutput,
  mockProjectLinkState,
  mockCliProjectLocalServiceVersions,
} from "../../../../tests/helpers/mocks.ts";
import {
  makeRunningStackFixture,
  makeStoppedStackFixture,
} from "../../../../tests/helpers/running-stack.ts";

describe("status handler", () => {
  it.live("attaches to a managed owner and renders live service information", () =>
    Effect.promise(() => makeRunningStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const apiPort = Number(new URL(fixture.stackInfo.url).port);
        const dbPort = Number(new URL(fixture.stackInfo.dbUrl).port);
        const configuredApiPort = apiPort === 54_321 ? 54_322 : 54_321;
        mkdirSync(join(fixture.projectRoot, "supabase"));
        writeFileSync(
          join(fixture.projectRoot, "supabase", "config.toml"),
          `project_id = "test"\n[api]\nport = ${configuredApiPort}\n[db]\nport = ${dbPort}\n`,
        );
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "success",
                  message: "Local Supabase stack is running.",
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "warn",
                  message: expect.stringContaining("changed from not yet allocated"),
                }),
              );
              expect(out.messages).not.toContainEqual(
                expect.objectContaining({
                  type: "warn",
                  message: expect.stringContaining("undefined"),
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: `API URL: ${fixture.stackInfo.url}`,
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "warn",
                  message: expect.stringContaining(
                    `api.port changed from ${apiPort} to ${configuredApiPort}`,
                  ),
                }),
              );
            }),
          ),
        );
      }),
    ),
  );

  it.live("reads stopped launch metadata from the managed document", () =>
    Effect.promise(() => makeStoppedStackFixture()).pipe(
      Effect.flatMap((fixture) => {
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() =>
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: "Local Supabase stack is stopped.",
                }),
              ),
            ),
          ),
        );
      }),
    ),
  );

  it.live("renders a degraded owner/document summary when the daemon CLI version differs", () =>
    Effect.promise(() =>
      makeRunningStackFixture({
        cliVersion: "2.60.0",
      }),
    ).pipe(
      Effect.flatMap((fixture) => {
        mkdirSync(join(fixture.projectRoot, "supabase"), { recursive: true });
        writeFileSync(join(fixture.projectRoot, "supabase", "config.toml"), "[invalid\n");
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "warn",
                  message: "Local Supabase stack is managed by a different CLI version.",
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: "Run `supabase start` to restart the stack with the current CLI.",
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({ type: "info", message: "State: running" }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({ type: "info", message: "Ready: true" }),
              );
              expect(out.messages).not.toContainEqual(
                expect.objectContaining({
                  type: "info",
                  message: expect.stringContaining("API URL:"),
                }),
              );
            }),
          ),
        );
      }),
    ),
  );

  it.live("returns only the degraded owner/document fields in structured output", () =>
    Effect.promise(() =>
      makeRunningStackFixture({
        cliVersion: "2.60.0",
      }),
    ).pipe(
      Effect.flatMap((fixture) => {
        mkdirSync(join(fixture.projectRoot, "supabase"), { recursive: true });
        writeFileSync(join(fixture.projectRoot, "supabase", "config.toml"), "[invalid\n");
        const out = mockOutput({ format: "json", interactive: false });
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              const success = out.messages.find((message) => message.type === "success");
              expect(success).toEqual(
                expect.objectContaining({
                  data: expect.objectContaining({
                    degraded: true,
                    reason: "daemon_upgrade_required",
                    daemon_cli_version: "2.60.0",
                    instruction: "Run `supabase start` to restart the stack with the current CLI.",
                  }),
                }),
              );
              expect(success?.data).not.toHaveProperty("api_url");
              expect(success?.data).not.toHaveProperty("services");
            }),
          ),
        );
      }),
    ),
  );

  it.live("reports an incompatible starting owner as not running in structured output", () =>
    Effect.promise(() =>
      makeRunningStackFixture({
        cliVersion: "2.60.0",
        ownerState: "starting",
      }),
    ).pipe(
      Effect.flatMap((fixture) => {
        mkdirSync(join(fixture.projectRoot, "supabase"), { recursive: true });
        writeFileSync(join(fixture.projectRoot, "supabase", "config.toml"), "[invalid\n");
        const out = mockOutput({ format: "json", interactive: false });
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              const success = out.messages.find((message) => message.type === "success");
              expect(success?.data).toEqual(
                expect.objectContaining({
                  degraded: true,
                  running: false,
                  state: "starting",
                  ready: false,
                  daemon_cli_version: "2.60.0",
                }),
              );
            }),
          ),
        );
      }),
    ),
  );

  it.live("renders an incompatible starting owner state in text output", () =>
    Effect.promise(() =>
      makeRunningStackFixture({
        cliVersion: "2.60.0",
        ownerState: "starting",
      }),
    ).pipe(
      Effect.flatMap((fixture) => {
        mkdirSync(join(fixture.projectRoot, "supabase"), { recursive: true });
        writeFileSync(join(fixture.projectRoot, "supabase", "config.toml"), "[invalid\n");
        const out = mockOutput();
        const layer = Layer.mergeAll(
          fixture.baseLayer,
          out.layer,
          mockProjectLinkState(),
          mockCliProjectLocalServiceVersions(),
          BunServices.layer,
        );
        return status({ stack: fixture.stackName }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => fixture.dispose())),
          Effect.andThen(
            Effect.sync(() => {
              expect(out.messages).toContainEqual(
                expect.objectContaining({
                  type: "warn",
                  message: "Local Supabase stack is managed by a different CLI version.",
                }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({ type: "info", message: "State: starting" }),
              );
              expect(out.messages).toContainEqual(
                expect.objectContaining({ type: "info", message: "Ready: false" }),
              );
            }),
          ),
        );
      }),
    ),
  );
});
