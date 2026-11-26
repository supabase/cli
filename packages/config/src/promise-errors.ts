import type { ConfigFormat } from "./config-format.ts";
import {
  fileConflictMessage,
  removedKeyMessage,
  removedKeySuggestion,
  schemaVersionMessage,
} from "./errors-core.ts";
import type { RemovedConfigKey } from "./removed-config-keys-core.ts";

/** One schema violation: a dotted `path` into the document and a human-readable `message`. */
export interface CliConfigValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** The config file failed to parse or to validate; `issues` lists each violation, and `cause` is the syntax error for a parse failure. */
// oxlint-disable-next-line effecttsgo/extends-native-error -- thrown by the effect-free `./io-promises` entry; `_tag` keeps Effect `catchTag` working.
export class CliConfigParseError extends Error {
  readonly _tag = "CliConfigParseError";
  override readonly name = "CliConfigParseError";
  readonly path: string;
  readonly format: ConfigFormat;
  readonly issues: ReadonlyArray<CliConfigValidationIssue>;
  readonly appliedRemote?: string;

  constructor(options: {
    readonly path: string;
    readonly format: ConfigFormat;
    readonly message: string;
    readonly cause?: unknown;
    readonly issues?: ReadonlyArray<CliConfigValidationIssue>;
    readonly appliedRemote?: string;
  }) {
    super(options.message, { cause: options.cause });
    this.path = options.path;
    this.format = options.format;
    this.issues = options.issues ?? [];
    if (options.appliedRemote !== undefined) {
      this.appliedRemote = options.appliedRemote;
    }
  }
}

/** A config document uses keys the config format no longer accepts; `removedKeys` lists every one with its replacement. */
// oxlint-disable-next-line effecttsgo/extends-native-error -- thrown by the effect-free `./io-promises` entry; `_tag` keeps Effect `catchTag` working.
export class CliConfigRemovedKeyError extends Error {
  readonly _tag = "CliConfigRemovedKeyError";
  override readonly name = "CliConfigRemovedKeyError";
  readonly path: string;
  readonly format: ConfigFormat;
  readonly removedKeys: ReadonlyArray<RemovedConfigKey>;

  constructor(options: {
    readonly path: string;
    readonly format: ConfigFormat;
    readonly removedKeys: ReadonlyArray<RemovedConfigKey>;
  }) {
    super(removedKeyMessage(options.path, options.removedKeys));
    this.path = options.path;
    this.format = options.format;
    this.removedKeys = options.removedKeys;
  }

  /** The edit that clears this error, for commands that print a remediation next to the message. */
  get suggestion(): string {
    return removedKeySuggestion(this.path);
  }
}

/** Both `config.json` and `config.jsonc` exist in one project; `paths` lists every conflicting file. */
// oxlint-disable-next-line effecttsgo/extends-native-error -- thrown by the effect-free `./io-promises` entry; `_tag` keeps Effect `catchTag` working.
export class CliConfigFileConflictError extends Error {
  readonly _tag = "CliConfigFileConflictError";
  override readonly name = "CliConfigFileConflictError";
  readonly paths: ReadonlyArray<string>;

  constructor(options: { readonly paths: ReadonlyArray<string> }) {
    super(fileConflictMessage(options.paths));
    this.paths = options.paths;
  }
}

/** A config file declares a schema version newer than this package reads. */
// oxlint-disable-next-line effecttsgo/extends-native-error -- thrown by the effect-free `./io-promises` entry; `_tag` keeps Effect `catchTag` working.
export class CliConfigSchemaVersionError extends Error {
  readonly _tag = "CliConfigSchemaVersionError";
  override readonly name = "CliConfigSchemaVersionError";
  readonly path: string;
  readonly format: ConfigFormat;
  readonly schemaRef: string;
  readonly declaredVersion: string;
  readonly supportedVersion: number;

  constructor(options: {
    readonly path: string;
    readonly format: ConfigFormat;
    readonly schemaRef: string;
    readonly declaredVersion: string;
    readonly supportedVersion: number;
  }) {
    super(schemaVersionMessage(options.path, options.declaredVersion, options.supportedVersion));
    this.path = options.path;
    this.format = options.format;
    this.schemaRef = options.schemaRef;
    this.declaredVersion = options.declaredVersion;
    this.supportedVersion = options.supportedVersion;
  }
}

/** A project `.env` or `.env.local` file has a line that is not a `KEY=value` entry. */
// oxlint-disable-next-line effecttsgo/extends-native-error -- thrown by the effect-free `./io-promises` entry; `_tag` keeps Effect `catchTag` working.
export class CliProjectEnvParseError extends Error {
  readonly _tag = "CliProjectEnvParseError";
  override readonly name = "CliProjectEnvParseError";
  readonly path: string;
  readonly line: number;

  constructor(options: { readonly path: string; readonly line: number }) {
    super(`Failed to parse ${options.path} at line ${options.line}`);
    this.path = options.path;
    this.line = options.line;
  }
}
