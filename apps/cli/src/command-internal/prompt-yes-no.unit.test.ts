import { describe, expect, it } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../tests/helpers/mocks.ts";
import { Output } from "../shared/output/output.service.ts";
import { Stdin } from "../shared/runtime/stdin.service.ts";

import { parseYesNo, promptYesNo } from "./prompt-yes-no.ts";

describe("parseYesNo", () => {
  it("parses affirmative answers (case-insensitive, trimmed)", () => {
    for (const input of ["y", "Y", "yes", "YES", " Yes ", "yEs"]) {
      expect(parseYesNo(input)).toBe(true);
    }
  });

  it("parses negative answers (case-insensitive, trimmed)", () => {
    for (const input of ["n", "N", "no", "NO", " No ", "nO"]) {
      expect(parseYesNo(input)).toBe(false);
    }
  });

  it("returns undefined for unparseable or empty input", () => {
    for (const input of ["", "  ", "maybe", "yeah", "1", "true", "yep"]) {
      expect(parseYesNo(input)).toBeUndefined();
    }
  });
});

describe("promptYesNo machine consent", () => {
  for (const format of ["json", "stream-json"] as const) {
    it.each([
      {
        readMachineStdin: false,
        stdinIsTty: false,
        interactive: true,
        defaultValue: false,
        expected: false,
        reads: 0,
      },
      {
        readMachineStdin: true,
        stdinIsTty: true,
        interactive: true,
        defaultValue: false,
        expected: false,
        reads: 0,
      },
      {
        readMachineStdin: true,
        stdinIsTty: false,
        interactive: false,
        defaultValue: false,
        expected: false,
        reads: 0,
      },
      {
        readMachineStdin: true,
        stdinIsTty: false,
        interactive: true,
        defaultValue: false,
        expected: true,
        reads: 1,
      },
      {
        readMachineStdin: true,
        stdinIsTty: false,
        interactive: false,
        defaultValue: true,
        expected: true,
        reads: 0,
      },
    ])(`${format} respects opt-in and input ownership: %j`, async (scenario) => {
      const out = mockOutput({ format });
      let reads = 0;
      const stdin = Layer.succeed(Stdin, {
        isTTY: scenario.stdinIsTty,
        readPipedBytes: Effect.die("unexpected whole-stream read"),
        pipedBytesStream: Stream.empty,
        readPipedText: Effect.die("unexpected whole-stream read"),
        readLine: () =>
          Effect.sync(() => {
            reads++;
            return Option.some("y");
          }),
      });
      const answer = await Effect.runPromise(
        Effect.gen(function* () {
          const output = yield* Output;
          return yield* promptYesNo(
            output,
            false,
            "Confirm?",
            scenario.defaultValue,
            scenario.interactive,
            { readMachineStdin: scenario.readMachineStdin },
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(out.layer, stdin, mockTty({ stdinIsTty: scenario.stdinIsTty })),
          ),
        ),
      );
      expect(answer).toBe(scenario.expected);
      expect(reads).toBe(scenario.reads);
      expect(out.stderrText).toBe(scenario.reads === 1 ? "Confirm? [y/N] y\n" : "");
    });
  }
});

describe("promptYesNo piped text answers", () => {
  const ask = (piped: string, defaultValue: boolean, interactive = true) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const output = yield* Output;
        return yield* promptYesNo(output, false, "Confirm?", defaultValue, interactive);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockOutput().layer,
            mockStdin(false, piped),
            mockTty({ stdinIsTty: false }),
          ),
        ),
      ),
    );

  it.each(["u", "yess", "nope", "   "])(
    "declines the unrecognised answer %j whatever the default",
    async (answer) => {
      expect(await ask(`${answer}\n`, true)).toBe(false);
      expect(await ask(`${answer}\n`, false)).toBe(false);
    },
  );

  it("keeps the default when a caller that never asked reads an unrecognised line", async () => {
    expect(await ask("echo next-step\n", true, false)).toBe(true);
    expect(await ask("echo next-step\n", false, false)).toBe(false);
    expect(await ask("   \n", true, false)).toBe(true);
  });

  it.each([true, false])("takes the default %j for an empty line or closed stdin", async (def) => {
    for (const interactive of [true, false]) {
      expect(await ask("\n", def, interactive)).toBe(def);
      expect(await ask("", def, interactive)).toBe(def);
    }
  });

  it("reads a blank line as present, then the next answer", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const output = yield* Output;
        const { readLine } = yield* Stdin;
        const first = yield* promptYesNo(output, false, "Confirm?", true);
        const second = yield* promptYesNo(output, false, "Confirm?", true);
        return [first, second, yield* readLine(0), yield* readLine(0)];
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockOutput().layer,
            mockStdin(false, "\nn\n\n"),
            mockTty({ stdinIsTty: false }),
          ),
        ),
      ),
    );
    expect(lines).toEqual([true, false, Option.some(""), Option.none()]);
  });

  it.each([
    ["y", true],
    ["yes", true],
    ["n", false],
    ["no", false],
  ] as const)("honours %j over the opposite default", async (answer, expected) => {
    expect(await ask(`${answer}\n`, !expected)).toBe(expected);
    expect(await ask(`${answer}\n`, !expected, false)).toBe(expected);
  });
});
