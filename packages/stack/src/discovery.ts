import { Effect } from "effect";
import type { ManagedStackManagerError, ManagedStackManagerShape } from "./managed/manager.ts";
import { ManagedStackManager } from "./managed/manager.ts";
import type { ManagedStackDocument } from "./managed/document.ts";
import {
  connectManagedStack,
  deleteManagedStack,
  resolveManagedDocument,
  stopManagedStack,
} from "./managed/lifecycle.ts";
import { PORT_CATALOG, PORT_FIELDS, type ResolvedPorts } from "./PortCatalog.ts";
import type { PartialVersionManifest } from "./versions.ts";
import { NoRunningStackError } from "./managed/model.ts";
import type { ManagedPortDrift, ManagedPortIntentDocument } from "./managed/model.ts";
import { HttpTransportClient } from "./HttpTransportClient.ts";
import type { Stack } from "./Stack.ts";

export interface StackSummary {
  readonly name: string;
  readonly running: boolean;
  readonly ports: ResolvedPorts;
  readonly versions: PartialVersionManifest;
  readonly pid?: number;
  readonly url?: string;
  readonly dbUrl?: string;
  readonly startedAt?: string;
  readonly lastNotifiedUpdateFingerprint?: string;
  readonly launch?: ManagedStackDocument["launch"];
  readonly drift?: ReadonlyArray<ManagedPortDrift>;
}

const portFieldByKey: Readonly<Record<string, keyof ResolvedPorts>> = Object.fromEntries(
  PORT_FIELDS.flatMap((field) => {
    const key = PORT_CATALOG[field].configKey;
    return key === undefined ? [] : [[key, field]];
  }),
);

const summaryForDocument = (
  document: ManagedStackDocument & { readonly drift?: ReadonlyArray<ManagedPortDrift> },
  running?: boolean,
): StackSummary => {
  const ports: Record<string, number> = {};
  for (const assignment of document.ports) {
    const field = portFieldByKey[assignment.key];
    if (field !== undefined) ports[field] = assignment.port;
  }
  if (ports.apiPort === undefined || ports.dbPort === undefined) {
    throw new Error("Managed stack document is missing api.port or db.port");
  }
  const { apiPort, dbPort } = ports;
  return {
    name: document.identity.name,
    running: running ?? (document.lifecycle === "running" && document.runtime !== undefined),
    ports: {
      ...ports,
      apiPort,
      dbPort,
    },
    versions: document.launch?.versions ?? {},
    ...(document.launch === undefined ? {} : { launch: document.launch }),
    ...(document.drift === undefined ? {} : { drift: document.drift }),
    ...(document.launch?.lastNotifiedUpdateFingerprint === undefined
      ? {}
      : { lastNotifiedUpdateFingerprint: document.launch.lastNotifiedUpdateFingerprint }),
    ...(document.runtime === undefined ? {} : { pid: document.runtime.pid }),
    startedAt: document.updatedAt,
  };
};

const liveStatus = (
  manager: ManagedStackManagerShape,
  document: ManagedStackDocument,
): Effect.Effect<boolean, ManagedStackManagerError, never> =>
  manager
    .probeControl(document.id)
    .pipe(Effect.map((status) => status?.state === "running" && status.ready));

export const listStacks = (opts: {
  readonly cacheRoot: string;
  readonly projectDir?: string;
}): Effect.Effect<ReadonlyArray<StackSummary>, ManagedStackManagerError, ManagedStackManager> =>
  Effect.gen(function* () {
    const manager = yield* ManagedStackManager;
    const listings = yield* manager.listStacks();
    const projectPath =
      opts.projectDir === undefined
        ? undefined
        : yield* manager.discoverWorkspace(opts.projectDir).pipe(
            Effect.map((workspace) => workspace.path),
            Effect.catchTag("UnsupportedGitWorkspaceError", () => Effect.succeed(null)),
          );
    if (projectPath === null) return [];
    const summaries = yield* Effect.forEach(listings, (listing) =>
      Effect.gen(function* () {
        if (
          listing.status !== "healthy" ||
          (projectPath !== undefined && listing.document.workspace.path !== projectPath)
        ) {
          return undefined;
        }
        const running = yield* liveStatus(manager, listing.document);
        return summaryForDocument(listing.document, running);
      }),
    );
    return summaries
      .filter((summary): summary is StackSummary => summary !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  });

export const resolveStackSummary = (opts: {
  readonly cacheRoot: string;
  readonly projectDir?: string;
  readonly cwd?: string;
  readonly name: string;
  readonly portDocument?: ManagedPortIntentDocument;
}): Effect.Effect<
  StackSummary,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager
> =>
  Effect.gen(function* () {
    const document = yield* resolveManagedDocument({
      workspacePath: opts.projectDir ?? opts.cwd ?? process.cwd(),
      stackName: opts.name,
      cwd: opts.cwd,
      ...(opts.portDocument === undefined ? {} : { portDocument: opts.portDocument }),
    });
    const manager = yield* ManagedStackManager;
    return summaryForDocument(document, yield* liveStatus(manager, document));
  });

export const stopDaemon = (opts: {
  readonly name?: string;
  readonly cwd?: string;
  readonly cacheRoot: string;
  readonly projectDir?: string;
}): Effect.Effect<
  void,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager | HttpTransportClient
> =>
  stopManagedStack({
    workspacePath: opts.projectDir ?? opts.cwd ?? process.cwd(),
    ...(opts.name === undefined ? {} : { stackName: opts.name }),
    cwd: opts.cwd,
  });

export const deleteManagedStackPersistence = (opts: {
  readonly name?: string;
  readonly cwd?: string;
  readonly cacheRoot: string;
  readonly projectDir?: string;
}): Effect.Effect<void, NoRunningStackError | ManagedStackManagerError, ManagedStackManager> =>
  deleteManagedStack({
    workspacePath: opts.projectDir ?? opts.cwd ?? process.cwd(),
    ...(opts.name === undefined ? {} : { stackName: opts.name }),
    cwd: opts.cwd,
  });

export type ManagedStack = ManagedStackDocument;

export const resolveManagedStack = (opts: {
  readonly cacheRoot: string;
  readonly name?: string;
  readonly cwd?: string;
  readonly projectDir?: string;
}): Effect.Effect<
  ManagedStack,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager
> =>
  resolveManagedDocument({
    workspacePath: opts.projectDir ?? opts.cwd ?? process.cwd(),
    ...(opts.name === undefined ? {} : { stackName: opts.name }),
    cwd: opts.cwd,
  });

export const connectManagedLayer = (opts: {
  readonly name?: string;
  readonly cwd?: string;
  readonly cacheRoot: string;
  readonly projectDir?: string;
}): Effect.Effect<
  import("effect").Layer.Layer<Stack>,
  NoRunningStackError | ManagedStackManagerError,
  ManagedStackManager | HttpTransportClient
> =>
  connectManagedStack({
    workspacePath: opts.projectDir ?? opts.cwd ?? process.cwd(),
    ...(opts.name === undefined ? {} : { stackName: opts.name }),
    cwd: opts.cwd,
  });
