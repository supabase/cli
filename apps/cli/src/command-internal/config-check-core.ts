import type { CliConfig } from "@supabase/config";
import { Effect, Exit, FileSystem, Path, type PlatformError } from "effect";

import { getDocumentValue, isDocumentRecord } from "../config/cli-config-document.ts";
import {
  ConfigValidateError,
  type ConfigUnitError,
  type ConfigValidationIssueCode,
  fsErrorCause,
  thrownError,
} from "./config-validate.ts";

type UnitKind = "value" | "requirement" | "file" | "counting";
export type Segments = ReadonlyArray<string>;

/**
 * How a unit reads config. Every read is recorded by a tracking implementation, so a unit must
 * read each switch it branches on (such as `auth.enabled`) through the view, inside its own `run`.
 */
export interface CliConfigView {
  /** The decoded value; a table read covers its subtree. */
  get(path: Segments): unknown;
  /** The as-written effective document value, before decoding. */
  written(path: Segments): unknown;
  /** Whether the as-written document holds the key. */
  has(path: Segments): boolean;
  /** The entry names of a table: as-written keys first, then decoded-only keys. */
  keys(path: Segments): ReadonlyArray<string>;
  /** Records that a switch the unit branches on holds an unusable value, so a validator defers the unit; a no-op outside validate. */
  defer(path: Segments): void;
  readonly workdir: string;
  readonly configPath: string | undefined;
  readonly hasDocument: boolean;
}

/** The view counting units get: it can also ask whether a value is known without recording a read. */
export interface CountingCliConfigView extends CliConfigView {
  /** Does not record a read, and is always true outside validate. */
  isKnown(path: Segments): boolean;
}

export interface CliConfigUnitFinding {
  readonly path: Segments;
  readonly code: ConfigValidationIssueCode;
  readonly message: string;
  readonly reason: string;
  readonly help?: string;
  readonly error: ConfigUnitError;
}

export type CliConfigUnitIoFlavor = "local" | "db";

/** File reads shared by every unit in one run, so each file is read once. */
export interface CliConfigUnitIo {
  readText(absPath: string): Effect.Effect<Exit.Exit<string, PlatformError.PlatformError>>;
  /** The value config messages quote for a failed read. */
  readFailureCause(error: PlatformError.PlatformError): unknown;
  /** False once the unit has read an unknown value; a unit must not touch the filesystem then. */
  filesAllowed(): boolean;
}

interface CliConfigCheckUnitBase {
  readonly id: string;
  /** The id of the check this one duplicates, so a validator counts their deferrals once. */
  readonly twin?: string;
  /** The smallest key prefix covering every key the unit reads. */
  readonly scope: Segments | ((entry: string) => Segments);
  /** Fans the unit out by entry name; the reads it makes are presence reads of the entries' table. */
  readonly entries?: (view: CliConfigView) => ReadonlyArray<string>;
}

type UnitEffect = Effect.Effect<
  ReadonlyArray<CliConfigUnitFinding>,
  never,
  FileSystem.FileSystem | Path.Path
>;

interface PlainCliConfigCheckUnit extends CliConfigCheckUnitBase {
  readonly kind: Exclude<UnitKind, "counting">;
  readonly run: (view: CliConfigView, io: CliConfigUnitIo, entry?: string) => UnitEffect;
}

interface CountingCliConfigCheckUnit extends CliConfigCheckUnitBase {
  readonly kind: "counting";
  readonly run: (view: CountingCliConfigView, io: CliConfigUnitIo, entry?: string) => UnitEffect;
}

export type CliConfigCheckUnit = PlainCliConfigCheckUnit | CountingCliConfigCheckUnit;

/** A view over a decoded config and its document that records nothing. */
export const untrackedCliConfigView = (input: {
  readonly config: CliConfig;
  readonly document?: Readonly<Record<string, unknown>>;
  readonly workdir: string;
  readonly configPath?: string;
}): CountingCliConfigView => ({
  get: (path) => getDocumentValue(input.config, path),
  written: (path) => getDocumentValue(input.document, path),
  has: (path) => getDocumentValue(input.document, path) !== undefined,
  keys: (path) => {
    const written = getDocumentValue(input.document, path);
    const decoded = getDocumentValue(input.config, path);
    return [
      ...new Set([
        ...(isDocumentRecord(written)
          ? Object.entries(written)
              .filter(
                ([, value]) =>
                  path.length !== 1 || path[0] !== "remotes" || isDocumentRecord(value),
              )
              .map(([key]) => key)
          : []),
        ...(isDocumentRecord(decoded) ? Object.keys(decoded) : []),
      ]),
    ];
  },
  isKnown: () => true,
  defer: () => undefined,
  workdir: input.workdir,
  configPath: input.configPath,
  hasDocument: input.document !== undefined,
});

/** `local` keeps a leading BOM and quotes the underlying fs error; `db` strips it and quotes the platform error. */
export const makeCliConfigUnitIo = Effect.fnUntraced(function* (flavor: CliConfigUnitIoFlavor) {
  const fs = yield* FileSystem.FileSystem;
  const cache = new Map<string, Exit.Exit<string, PlatformError.PlatformError>>();
  const read = (absPath: string) =>
    flavor === "db"
      ? fs.readFileString(absPath)
      : fs
          .readFile(absPath)
          .pipe(Effect.map((bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)));
  const io: CliConfigUnitIo = {
    readText: (absPath) =>
      Effect.suspend(() => {
        const cached = cache.get(absPath);
        if (cached !== undefined) return Effect.succeed(cached);
        return read(absPath).pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              cache.set(absPath, exit);
            }),
          ),
        );
      }),
    readFailureCause: flavor === "db" ? (error) => error : fsErrorCause,
    filesAllowed: () => true,
  };
  return io;
});

/** Runs the units in order and fails with the first finding's error. */
export const runConfigUnitsFirst = Effect.fnUntraced(function* (
  units: ReadonlyArray<CliConfigCheckUnit>,
  view: CountingCliConfigView,
  io: CliConfigUnitIo,
) {
  for (const unit of units) {
    const entries = unit.entries === undefined ? [undefined] : unit.entries(view);
    for (const entry of entries) {
      const [first] = yield* unit.run(view, io, entry);
      if (first !== undefined) return yield* first.error;
    }
  }
});

const ENTRY_SEPARATOR = "\0";

/** Entries for a unit that checks one field per named entry, in name-major order. */
export const fieldEntries = (
  names: ReadonlyArray<string>,
  fields: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  names.flatMap((name) => fields.map((field) => `${name}${ENTRY_SEPARATOR}${field}`));

export const splitFieldEntry = (entry: string): readonly [name: string, field: string] => {
  const [name = "", field = ""] = entry.split(ENTRY_SEPARATOR);
  return [name, field];
};

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
export const nonEmpty = (value: unknown): string | undefined => {
  const text = str(value);
  return text === undefined || text.length === 0 ? undefined : text;
};
export const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const dotted = (path: Segments): string => path.join(".");

export const finding = (
  path: Segments,
  code: ConfigValidationIssueCode,
  message: string,
  reason: string,
  help?: string,
  error: ConfigUnitError = new ConfigValidateError(message),
): CliConfigUnitFinding => ({
  path,
  code,
  message,
  reason,
  ...(help === undefined ? {} : { help }),
  error,
});

export const invalid = (
  path: Segments,
  message: string,
  reason: string,
  help?: string,
  code: ConfigValidationIssueCode = "invalid_value",
): CliConfigUnitFinding => finding(path, code, message, reason, help);

export const missing = (
  path: Segments,
  gate?: Segments,
  options: { readonly message?: string; readonly reason?: string; readonly help?: string } = {},
): CliConfigUnitFinding => {
  const leaf = path.at(-1) ?? "";
  const sibling = gate !== undefined && gate.slice(0, -1).join(".") === path.slice(0, -1).join(".");
  return finding(
    path,
    "missing_required",
    options.message ?? `Missing required field in config: ${dotted(path)}`,
    options.reason ??
      (gate === undefined ? "missing required key" : `required when ${dotted(gate)} = true`),
    options.help ??
      (gate === undefined
        ? `set ${dotted(path)}`
        : `set ${leaf}, or set ${sibling ? (gate.at(-1) ?? "") : dotted(gate)} = false`),
  );
};

export const thrown = (
  path: Segments,
  cause: unknown,
  reason: string,
  help: string,
  code: ConfigValidationIssueCode = "invalid_value",
): CliConfigUnitFinding => {
  const error = thrownError(cause);
  return finding(path, code, error.message, reason, help, error);
};

export const readText = (io: CliConfigUnitIo, absPath: string) =>
  io.readText(absPath).pipe(Effect.flatMap((exit) => Effect.result(exit)));

export const syncUnit = (
  spec: Omit<PlainCliConfigCheckUnit, "run"> & {
    readonly check: (view: CliConfigView, entry: string) => ReadonlyArray<CliConfigUnitFinding>;
  },
): CliConfigCheckUnit => {
  const { check, ...unit } = spec;
  return {
    ...unit,
    run: (view: CliConfigView, _io: CliConfigUnitIo, entry?: string) =>
      Effect.sync(() => check(view, entry ?? "")),
  };
};

export const countingUnit = (
  spec: Omit<CountingCliConfigCheckUnit, "run" | "kind"> & {
    readonly check: (
      view: CountingCliConfigView,
      entry: string,
    ) => ReadonlyArray<CliConfigUnitFinding>;
  },
): CliConfigCheckUnit => {
  const { check, ...unit } = spec;
  return {
    ...unit,
    kind: "counting",
    run: (view: CountingCliConfigView, _io: CliConfigUnitIo, entry?: string) =>
      Effect.sync(() => check(view, entry ?? "")),
  };
};
