import { Data, Effect, Schema } from "effect";
import type { ManagedPortAssignment } from "./model.ts";
import { PartialVersionManifestSchema } from "../versions.ts";

export type ManagedStackDocumentLifecycle =
  | "stopped"
  | "starting"
  | "running"
  | "deleting"
  | "failed";

const managedStackLaunchFields = {
  versions: PartialVersionManifestSchema,
  excludedServices: Schema.optionalKey(Schema.Array(Schema.String)),
  lastNotifiedUpdateFingerprint: Schema.optionalKey(Schema.String),
} as const;

export const managedStackLaunchUpdateSchema = Schema.Struct(managedStackLaunchFields);
export type ManagedStackLaunchUpdate = Schema.Schema.Type<typeof managedStackLaunchUpdateSchema>;

const managedStackLaunchSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("native"),
    ...managedStackLaunchFields,
  }),
  Schema.Struct({
    mode: Schema.Literal("docker"),
    containerRuntime: Schema.Literals(["docker", "podman"] as const),
    ...managedStackLaunchFields,
  }),
  Schema.Struct(managedStackLaunchFields),
]);

export type ManagedStackLaunch = Schema.Schema.Type<typeof managedStackLaunchSchema>;

export interface ManagedStackDocument {
  readonly format: "supabase-stack";
  readonly formatVersion: 1;
  readonly id: string;
  readonly identity: {
    readonly workspaceId: string;
    readonly checkoutId: string;
    readonly contextId: string;
    readonly localProjectKey: string;
    readonly name: string;
  };
  readonly workspace: {
    readonly kind: "git" | "folder";
    readonly checkoutKind: "primary" | "worktree" | "bare" | "folder";
    readonly path: string;
    readonly branch?: string;
  };
  readonly ports: ReadonlyArray<ManagedPortAssignment>;
  readonly lifecycle: ManagedStackDocumentLifecycle;
  readonly runtime?: {
    readonly pid: number;
    readonly controlEndpoint: string;
    readonly protocolVersion: 1;
  };
  readonly launch?: ManagedStackLaunch;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Launch request before the supervisor selects a concrete execution mode. */
export const managedStackLaunchInputSchema = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["native", "docker"] as const)),
  ...managedStackLaunchFields,
});

export type ManagedStackLaunchInput = Schema.Schema.Type<typeof managedStackLaunchInputSchema>;

const managedPortAssignmentSchema = Schema.Struct({
  key: Schema.Literals([
    "api.port",
    "db.port",
    "edge_runtime.inspector_port",
    "local_smtp.port",
    "local_smtp.smtp_port",
    "local_smtp.pop3_port",
    "studio.port",
    "analytics.port",
    "db.pooler.port",
  ]),
  port: Schema.Number,
  intent: Schema.Literals(["automatic", "exact"]),
});

const managedStackDocumentSchema = Schema.Struct({
  format: Schema.Literal("supabase-stack"),
  formatVersion: Schema.Literal(1),
  id: Schema.String,
  identity: Schema.Struct({
    workspaceId: Schema.String,
    checkoutId: Schema.String,
    contextId: Schema.String,
    localProjectKey: Schema.String,
    name: Schema.String,
  }),
  workspace: Schema.Struct({
    kind: Schema.Literals(["git", "folder"]),
    checkoutKind: Schema.Literals(["primary", "worktree", "bare", "folder"]),
    path: Schema.String,
    branch: Schema.optionalKey(Schema.String),
  }),
  ports: Schema.Array(managedPortAssignmentSchema),
  lifecycle: Schema.Literals(["stopped", "starting", "running", "deleting", "failed"]),
  runtime: Schema.optionalKey(
    Schema.Struct({
      pid: Schema.Number,
      controlEndpoint: Schema.String,
      protocolVersion: Schema.Literal(1),
    }),
  ),
  launch: Schema.optionalKey(managedStackLaunchSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ManagedStackDocumentSchema = Schema.fromJsonString(managedStackDocumentSchema);

const hasCorePortAssignments = (document: Pick<ManagedStackDocument, "ports">): boolean =>
  document.ports.some((assignment) => assignment.key === "api.port") &&
  document.ports.some((assignment) => assignment.key === "db.port");

export class InvalidManagedStackDocumentError extends Data.TaggedError(
  "InvalidManagedStackDocumentError",
)<{
  readonly path: string;
}> {
  override get message(): string {
    return `Managed stack document is invalid: ${this.path}`;
  }
}

const decodeDocument = Schema.decodeUnknownSync(ManagedStackDocumentSchema);
const encodeDocument = Schema.encodeUnknownSync(managedStackDocumentSchema);

export const decodeManagedStackDocument = (
  path: string,
  content: string,
): Effect.Effect<ManagedStackDocument, InvalidManagedStackDocumentError> =>
  Effect.try({
    try: () => {
      const document = decodeDocument(content);
      if (!hasCorePortAssignments(document)) {
        throw new Error("Managed document is missing core port assignments");
      }
      return document;
    },
    catch: () => new InvalidManagedStackDocumentError({ path }),
  });

export const encodeManagedStackDocument = (
  path: string,
  document: ManagedStackDocument,
): Effect.Effect<string, InvalidManagedStackDocumentError> =>
  Effect.try({
    try: () => {
      if (!hasCorePortAssignments(document)) {
        throw new Error("Managed document is missing core port assignments");
      }
      return JSON.stringify(encodeDocument(document), null, 2) + "\n";
    },
    catch: () => new InvalidManagedStackDocumentError({ path }),
  });
