import { Schema } from "effect";

const PgProveMount = Schema.Struct({
  source: Schema.String,
  target: Schema.String,
});

export const PgProveOptions = Schema.Struct({
  mounts: Schema.Array(PgProveMount),
  cwd: Schema.optional(Schema.String),
  workingDir: Schema.optional(Schema.String),
});
export interface PgProveOptions extends Schema.Schema.Type<typeof PgProveOptions> {}

export const PostgresCommand = Schema.Struct({
  command: Schema.Literals(["pg_dump", "pg_dumpall", "pg_prove", "psql"]),
  major: Schema.Literals([15, 17]),
});
export interface PostgresCommand extends Schema.Schema.Type<typeof PostgresCommand> {}

const AuthInitializationCommand = Schema.Struct({
  type: Schema.Literal("auth.initialize"),
  version: Schema.optional(Schema.String),
  databaseUrl: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const StorageInitializationCommand = Schema.Struct({
  type: Schema.Literal("storage.initialize"),
  version: Schema.optional(Schema.String),
  databaseUrl: Schema.String,
  filePath: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const RealtimeInitializationCommand = Schema.Struct({
  type: Schema.Literal("realtime.initialize"),
  version: Schema.optional(Schema.String),
  databaseUrl: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** A finite service setup action with inputs owned by its service definition. */
export const InitializationCommand = Schema.Union([
  AuthInitializationCommand,
  StorageInitializationCommand,
  RealtimeInitializationCommand,
]);
export type InitializationCommand = Schema.Schema.Type<typeof InitializationCommand>;

/** A finite action that runs to completion and does not own service lifecycle. */
export const Command = Schema.Union([PostgresCommand, InitializationCommand]);
export type Command = Schema.Schema.Type<typeof Command>;

const PostgresInvocation = Schema.Struct({
  type: Schema.Literal("postgres"),
  command: PostgresCommand,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  pgProve: Schema.optional(PgProveOptions),
  stdin: Schema.Boolean,
});

/** A command invocation serialized through the stack host attachment. */
export const CommandInvocation = Schema.Union([
  PostgresInvocation,
  AuthInitializationCommand,
  StorageInitializationCommand,
  RealtimeInitializationCommand,
]);
export type CommandInvocation = Schema.Schema.Type<typeof CommandInvocation>;

export interface ResolvedCommand {
  readonly service: "auth" | "storage" | "realtime";
  readonly version: string;
  readonly image: string;
  readonly nativeExecutable: string;
  readonly containerEntrypoint: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly workingDir?: string;
  readonly mounts: ReadonlyArray<{
    readonly source: string;
    readonly target: string;
    readonly readOnly: boolean;
  }>;
}

/** Describes PostgreSQL clients without managing a database service. */
export const postgres = {
  pgDump: ({ major }: { readonly major: 15 | 17 }): PostgresCommand => ({
    command: "pg_dump",
    major,
  }),
  pgDumpAll: ({ major }: { readonly major: 15 | 17 }): PostgresCommand => ({
    command: "pg_dumpall",
    major,
  }),
  pgProve: ({ major }: { readonly major: 15 | 17 }): PostgresCommand => ({
    command: "pg_prove",
    major,
  }),
  psql: ({ major }: { readonly major: 15 | 17 }): PostgresCommand => ({
    command: "psql",
    major,
  }),
};

export const initialization = {
  auth: (input: Omit<Extract<InitializationCommand, { type: "auth.initialize" }>, "type">) => ({
    type: "auth.initialize" as const,
    ...input,
  }),
  storage: (
    input: Omit<Extract<InitializationCommand, { type: "storage.initialize" }>, "type">,
  ) => ({ type: "storage.initialize" as const, ...input }),
  realtime: (
    input: Omit<Extract<InitializationCommand, { type: "realtime.initialize" }>, "type">,
  ) => ({ type: "realtime.initialize" as const, ...input }),
};
