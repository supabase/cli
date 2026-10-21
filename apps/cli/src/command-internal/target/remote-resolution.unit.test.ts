import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Sink, Stdio, Stream } from "effect";
import { vi } from "vitest";

import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockCommandSettings } from "../../../tests/helpers/command-mocks.ts";
import { mockTty } from "../../../tests/helpers/mocks.ts";
import {
  jsonOutputLayer,
  streamJsonOutputLayer,
  textOutputLayer,
} from "../../shared/output/output.layer.ts";
import { Output } from "../../shared/output/output.service.ts";
import type { Tty } from "../../shared/runtime/tty.service.ts";
import { selectTarget } from "./remote-resolution.ts";
import type { TargetFlagValues } from "./target-flags.ts";

const clack = vi.hoisted(() => ({
  log: { message: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
}));

vi.mock("@clack/prompts", () => ({
  log: clack.log,
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(),
}));

const sink = (chunks: Array<string>) =>
  Sink.forEach((item: string | Uint8Array) =>
    Effect.sync(() => {
      chunks.push(typeof item === "string" ? item : new TextDecoder().decode(item));
    }),
  );

const PAYLOAD = "export type Database = {}\n";
const flags = (overrides: Partial<TargetFlagValues>): TargetFlagValues => ({
  remote: Option.none(),
  local: false,
  linked: false,
  projectRef: Option.none(),
  ...overrides,
});

const runWith = (
  outputLayer: Layer.Layer<Output, never, Stdio.Stdio | Tty>,
  selector: TargetFlagValues,
) => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const stdio = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () => sink(stdout),
      stderr: () => sink(stderr),
    }),
  );
  return Effect.gen(function* () {
    yield* selectTarget(selector);
    const output = yield* Output;
    yield* output.raw(PAYLOAD);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(outputLayer, mockCommandSettings({ workdir: "/unused" })).pipe(
        Layer.provide(Layer.merge(stdio, mockTty())),
      ),
    ),
    Effect.map(() => ({ stdout: stdout.join(""), stderr: stderr.join("") })),
  );
};

describe("selectTarget deprecation warnings", () => {
  it.effect.each([
    { format: "text", layer: textOutputLayer },
    { format: "json", layer: jsonOutputLayer },
    { format: "stream-json", layer: streamJsonOutputLayer },
  ])("leaves stdout to the payload in $format mode", ({ layer }) =>
    Effect.gen(function* () {
      const remoteRun = yield* runWith(layer, flags({ remote: Option.some({ _tag: "Linked" }) }));
      const aliasRun = yield* runWith(layer, flags({ linked: true }));

      expect(aliasRun.stdout).toBe(PAYLOAD);
      expect(aliasRun.stdout).toBe(remoteRun.stdout);
      expect(remoteRun.stderr).toBe("");
      expect(stripAnsi(aliasRun.stderr)).toBe(
        "Warning: --linked is deprecated and will be removed in v4. Use --remote instead\n",
      );
      expect(clack.log.warn).not.toHaveBeenCalled();
    }),
  );
});
