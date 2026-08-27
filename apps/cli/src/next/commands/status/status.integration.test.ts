import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpTransportClient } from "@supabase/stack/testing";
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

const runDegradedStatus = (
  options: {
    readonly fixture?: Parameters<typeof makeRunningStackFixture>[0];
    readonly output?: Parameters<typeof mockOutput>[0];
    readonly transport?: HttpTransportClient["Service"];
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => makeRunningStackFixture({ cliVersion: "2.60.0", ...options.fixture })),
        (fixture) => Effect.promise(() => fixture.dispose()),
      );
      mkdirSync(join(fixture.projectRoot, "supabase"), { recursive: true });
      writeFileSync(join(fixture.projectRoot, "supabase", "config.toml"), "[invalid\n");
      const out = mockOutput(options.output);
      const layer = Layer.mergeAll(
        fixture.baseLayer,
        ...(options.transport === undefined
          ? []
          : [Layer.succeed(HttpTransportClient, options.transport)]),
        out.layer,
        mockProjectLinkState(),
        mockCliProjectLocalServiceVersions(),
        BunServices.layer,
      );
      yield* status({ stack: fixture.stackName }).pipe(Effect.provide(layer));
      return out;
    }),
  );

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
    runDegradedStatus().pipe(
      Effect.tap((out) =>
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
      Effect.asVoid,
    ),
  );

  it.live("does not parse checkout config before an RPC handshake detects an upgrade", () =>
    runDegradedStatus({
      fixture: { cliVersion: undefined },
      transport: {
        request: (endpoint, path, init) =>
          Effect.promise(async () => {
            const response = await fetch(`${endpoint.url}${path}`, {
              ...init,
              signal: init?.signal === null ? undefined : init?.signal,
            });
            if (path !== "/owner") return response;
            const owner = await response.json();
            if (typeof owner !== "object" || owner === null) return response;
            return new Response(JSON.stringify({ ...owner, daemonCliVersion: "2.60.0" }), {
              status: response.status,
              headers: response.headers,
            });
          }),
      },
    }).pipe(
      Effect.tap((out) =>
        Effect.sync(() => {
          expect(out.messages).toContainEqual(
            expect.objectContaining({
              type: "warn",
              message: "Local Supabase stack is managed by a different CLI version.",
            }),
          );
          expect(out.messages).not.toContainEqual(
            expect.objectContaining({
              type: "fail",
              message: expect.stringContaining("config"),
            }),
          );
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.live("returns only the degraded owner/document fields in structured output", () =>
    runDegradedStatus({ output: { format: "json", interactive: false } }).pipe(
      Effect.tap((out) =>
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
      Effect.asVoid,
    ),
  );

  it.live("reports an incompatible starting owner as not running in structured output", () =>
    runDegradedStatus({
      fixture: { ownerState: "starting" },
      output: { format: "json", interactive: false },
    }).pipe(
      Effect.tap((out) =>
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
      Effect.asVoid,
    ),
  );

  it.live("renders an incompatible starting owner state in text output", () =>
    runDegradedStatus({ fixture: { ownerState: "starting" } }).pipe(
      Effect.tap((out) =>
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
      Effect.asVoid,
    ),
  );
});
