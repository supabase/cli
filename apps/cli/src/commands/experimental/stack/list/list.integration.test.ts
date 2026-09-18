import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import {
  createStack,
  StackIdSchema,
  StackStateInvalidError,
  type StackDescriptor,
  type StackDiscoveryIssue,
} from "@supabase/stack/effect";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { mockTelemetryStateTracked } from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../../../shared/output/output.layer.ts";
import { StackApi, stackApiLayer } from "../stack.shared.ts";
import { stackList } from "./list.handler.ts";
import { StackCommandListError } from "./list.errors.ts";

const descriptor = (
  id: string,
  projectRoot: string,
  name: string,
  desiredLifecycle: StackDescriptor["desiredLifecycle"],
): StackDescriptor => ({
  id: StackIdSchema.make(id.repeat(64)),
  projectRoot,
  name,
  branchContext: `${name}-branch`,
  runtime: { kind: "native" },
  desiredLifecycle,
});

const setup = (options: {
  stacks?: ReadonlyArray<StackDescriptor>;
  errors?: ReadonlyArray<StackDiscoveryIssue>;
  discoveryError?: StackDiscoveryIssue["error"];
  outputFormat?: "text" | "json" | "stream-json";
  outputFlag?: boolean;
}) => {
  const output = mockOutput({ format: options.outputFormat });
  const telemetry = mockTelemetryStateTracked();
  return {
    output,
    telemetry,
    layer: Layer.mergeAll(
      output.layer,
      telemetry.layer,
      Layer.succeed(StackApi, {
        findStack: () => Effect.die("unused"),
        createStack: () => Effect.die("unused"),
        openStack: () => Effect.die("unused"),
        inspectStack: () => Effect.die("unused"),
        discoverStacks: () =>
          options.discoveryError === undefined
            ? Effect.succeed({ stacks: options.stacks ?? [], errors: options.errors ?? [] })
            : Effect.fail(options.discoveryError),
      }),
      ...(options.outputFlag ? [Layer.succeed(OutputFlag, Option.some("json"))] : []),
      BunServices.layer,
    ),
  };
};

describe("stack list", () => {
  it.live("sorts persisted stacks and includes stopped and unconfigured lifecycles", () => {
    const fixture = setup({
      stacks: [
        descriptor("e", "/work/z", "aaa", "stopped"),
        descriptor("a", "/work/a", "beta", "running"),
        descriptor("c", "/work/a", "alpha", "unconfigured"),
        descriptor("b", "/work/a", "alpha", "stopped"),
      ],
    });
    return stackList().pipe(
      Effect.tap((entries) =>
        Effect.sync(() => {
          expect(entries.map(({ id }) => id)).toEqual(
            ["b", "c", "a", "e"].map((id) => id.repeat(64)),
          );
          expect(fixture.output.stdoutText.indexOf("beta")).toBeLessThan(
            fixture.output.stdoutText.indexOf("aaa"),
          );
          expect(fixture.output.stdoutText.indexOf("alpha")).toBeLessThan(
            fixture.output.stdoutText.indexOf("beta"),
          );
          expect(fixture.output.stdoutText.indexOf("bbbbbbbb")).toBeLessThan(
            fixture.output.stdoutText.indexOf("cccccccc"),
          );
          expect(fixture.output.stdoutText).toContain("DESIRED");
          expect(fixture.output.stdoutText).toContain("stopped");
          expect(fixture.output.stdoutText).toContain("unconfigured");
          expect(fixture.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("reports an empty registry", () => {
    const fixture = setup({});
    return stackList().pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(fixture.output.stdoutText).toBe("No managed stacks found.\n")),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("lists a real registry exhaustively in text, JSON, and NDJSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "stack-list-registry-" });
        const project = path.join(home, "project");
        yield* fs.makeDirectory(project);
        const telemetry = mockTelemetryStateTracked();
        yield* Effect.gen(function* () {
          const healthy = yield* createStack({
            projectRoot: project,
            name: "healthy",
            runtime: { kind: "native" },
          });
          const registry = path.join(home, "stacks");
          const corrupt = "b".repeat(64);
          const unsupported = "c".repeat(64);
          const remnant = "d".repeat(64);
          for (const id of [corrupt, unsupported, remnant, "not-a-stack-id"]) {
            yield* fs.makeDirectory(path.join(registry, id));
          }
          yield* fs.writeFileString(path.join(registry, corrupt, "state.json"), "{corrupt");
          yield* fs.writeFileString(
            path.join(registry, unsupported, "state.json"),
            '{"format":"unsupported-example"}',
          );
          const text = mockOutput();
          const entries = yield* stackList().pipe(Effect.provide(text.layer));
          expect(entries.map(({ id }) => id)).toEqual([healthy.id, corrupt, unsupported]);
          expect(text.stdoutText).toContain("NAME");
          expect(text.stdoutText).toContain("healthy");
          expect(text.stdoutText).toContain("unconfigured");
          expect(text.stdoutText).toContain(healthy.id.slice(0, 8));
          expect(text.stdoutText).not.toContain(healthy.id);
          expect(text.stdoutText).toContain("Unreadable stacks:");
          for (const id of [corrupt, unsupported]) {
            expect(text.stdoutText.split(id)).toHaveLength(2);
          }
          expect(text.stdoutText).toContain("Unable to parse state document");
          expect(text.stdoutText).toContain("Unsupported stack state format");
          expect(text.stdoutText).not.toContain(remnant);
          expect(entries).toEqual([
            expect.objectContaining({
              id: healthy.id,
              readable: true,
              name: "healthy",
              runtime: { kind: "native" },
              desired_lifecycle: "unconfigured",
            }),
            {
              id: corrupt,
              readable: false,
              error: {
                code: "StackStateInvalidError",
                message: expect.stringContaining(`Failed to read managed stack ${corrupt}:`),
              },
            },
            {
              id: unsupported,
              readable: false,
              error: {
                code: "StackStateFormatUnsupportedError",
                message: expect.stringContaining(`Failed to read managed stack ${unsupported}:`),
              },
            },
          ]);
          for (const format of ["json", "stream-json"] as const) {
            const stdout: string[] = [];
            const stderr: string[] = [];
            const capture = (target: string[]) =>
              Sink.forEach((chunk: string | Uint8Array) =>
                Effect.sync(() => {
                  target.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
                }),
              );
            const stdio = Layer.succeed(
              Stdio.Stdio,
              Stdio.make({
                args: Effect.succeed([]),
                stdin: Stream.empty,
                stdout: () => capture(stdout),
                stderr: () => capture(stderr),
              }),
            );
            const output = (format === "json" ? jsonOutputLayer : streamJsonOutputLayer).pipe(
              Layer.provide(stdio),
            );
            yield* stackList().pipe(Effect.provide(output));
            const lines = stdout.join("").trim().split("\n");
            expect(lines).toHaveLength(1);
            const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
              lines[0],
            );
            if (format === "json") expect(result).toEqual({ stacks: entries, message: "" });
            else
              expect(result).toEqual({
                type: "result",
                timestamp: expect.any(String),
                data: { stacks: entries, message: "" },
              });
            expect(stderr).toEqual([]);
          }
          yield* fs.remove(path.join(registry, healthy.id), { recursive: true });
          const unreadableText = mockOutput();
          const unreadable = yield* stackList().pipe(Effect.provide(unreadableText.layer));
          expect(unreadable.map(({ id }) => id)).toEqual([corrupt, unsupported]);
          expect(unreadableText.stdoutText).not.toContain("NAME");
          expect(unreadableText.stdoutText).not.toContain("No managed stacks found.");
          expect(telemetry.flushed).toBe(true);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              stackApiLayer,
              telemetry.layer,
              ConfigProvider.layer(ConfigProvider.fromUnknown({ SUPABASE_HOME: home })),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("orders unreadable IDs after readable stacks regardless of discovery order", () => {
    const healthy = descriptor("f", "/work", "healthy", "stopped");
    const fixture = setup({
      stacks: [healthy],
      errors: ["c", "b"].map((prefix) => {
        const id = StackIdSchema.make(prefix.repeat(64));
        return {
          id,
          error: new StackStateInvalidError({
            message: `Failed to read managed stack ${id}: corrupt state`,
          }),
        };
      }),
    });
    return stackList().pipe(
      Effect.tap((entries) =>
        Effect.sync(() => {
          expect(entries.map(({ id }) => id)).toEqual([healthy.id, "b".repeat(64), "c".repeat(64)]);
          expect(fixture.output.stdoutText.indexOf("b".repeat(64))).toBeLessThan(
            fixture.output.stdoutText.indexOf("c".repeat(64)),
          );
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("fails registry discovery without emitting a partial result", () => {
    const fixture = setup({
      discoveryError: new StackStateInvalidError({ message: "registry unavailable" }),
    });
    return stackList().pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(StackCommandListError);
          expect(error.reason).toBe("invalid-config");
          expect(error.message).toContain("registry unavailable");
          expect(fixture.output.stdoutText).toBe("");
          expect(fixture.output.messages).toHaveLength(0);
          expect(fixture.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("rejects the legacy output flag", () => {
    const fixture = setup({ outputFlag: true });
    return stackList().pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(StackCommandListError);
          expect(error.reason).toBe("flags");
          expect(fixture.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });
});
