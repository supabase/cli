import { Duration, Effect, Option, Ref, Stream } from "effect";

export interface CommandOutputProcess<E> {
  readonly stdout: Stream.Stream<Uint8Array, E>;
  readonly stderr: Stream.Stream<Uint8Array, E>;
  readonly exitCode: Effect.Effect<number, E>;
}

export type CommandOutputResult =
  | {
      readonly timedOut: true;
      readonly output: Readonly<{ stdout: ReadonlyArray<string>; stderr: ReadonlyArray<string> }>;
    }
  | {
      readonly timedOut: false;
      readonly exitCode: number;
      readonly output: Readonly<{ stdout: ReadonlyArray<string>; stderr: ReadonlyArray<string> }>;
    };

const maxTailLines = 20;
const maxLineChars = 1_000;

const clipLine = (line: string) =>
  line.length > maxLineChars
    ? `…${line.slice(-maxLineChars).replace(/^[\uDC00-\uDFFF]/, "")}`
    : line;

/** Captures bounded process output while streaming bytes to the owning observer. */
export const awaitCommandOutput = <E, E2 = never, R = never>(
  process: CommandOutputProcess<E>,
  options: {
    readonly timeout: Duration.Input;
    readonly onOutput?: (
      stream: "stdout" | "stderr",
      bytes: Uint8Array,
    ) => Effect.Effect<void, E2, R>;
  },
): Effect.Effect<CommandOutputResult, E | E2, R> =>
  Effect.gen(function* () {
    const collect = (
      source: Stream.Stream<Uint8Array, E>,
      name: "stdout" | "stderr",
      tail: Ref.Ref<ReadonlyArray<string>>,
    ) =>
      Effect.gen(function* () {
        const appendLines = (lines: ReadonlyArray<string>) =>
          Ref.update(tail, (current) =>
            [...current, ...lines.filter((line) => line.trim().length > 0).map(clipLine)].slice(
              -maxTailLines,
            ),
          );
        const partial = yield* Ref.make("");
        yield* source.pipe(
          Stream.tap((bytes) => options.onOutput?.(name, bytes) ?? Effect.void),
          Stream.decodeText,
          Stream.runForEach((text) =>
            Ref.modify(partial, (rest): [ReadonlyArray<string>, string] => {
              const lines = `${rest}${text}`.split(/\r?\n/);
              const next = lines.pop() ?? "";
              return [lines, next.slice(-(maxLineChars + 1))];
            }).pipe(Effect.flatMap(appendLines)),
          ),
          Effect.ensuring(Ref.get(partial).pipe(Effect.flatMap((rest) => appendLines([rest])))),
        );
      });
    const stdout = yield* Ref.make<ReadonlyArray<string>>([]);
    const stderr = yield* Ref.make<ReadonlyArray<string>>([]);
    const completed = yield* Effect.all(
      [
        collect(process.stdout, "stdout", stdout),
        collect(process.stderr, "stderr", stderr),
        process.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.timeoutOption(options.timeout));
    const output = { stdout: yield* Ref.get(stdout), stderr: yield* Ref.get(stderr) };
    if (Option.isNone(completed)) return { timedOut: true, output };
    return { timedOut: false, exitCode: Number(completed.value[2]), output };
  });
