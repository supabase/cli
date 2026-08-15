import { compareManagedText } from "./repository.ts";
import type { ManagedIdentityTransitionRecord, ManagedOperationRecord } from "./model.ts";
import type { ManagedRecoveryOperation, ManagedWorkspaceDiscovery } from "./discovery.ts";

const observationValue = (value: string | number | boolean | undefined): string => {
  const text = value === undefined ? "" : String(value);
  return `${value === undefined ? "u" : "v"}${text.length}:${text}`;
};

const observationList = (values: ReadonlyArray<string>): string =>
  observationValue(values.join(""));

const sortedBy = <T>(values: ReadonlyArray<T>, key: (value: T) => string): ReadonlyArray<T> =>
  [...values].sort((left, right) => compareManagedText(key(left), key(right)));

const stringRecordObservation = (record: Readonly<Record<string, string>>): string =>
  observationList(
    Object.entries(record)
      .sort(([left], [right]) => compareManagedText(left, right))
      .flatMap(([key, value]) => [observationValue(key), observationValue(value)]),
  );

const numberRecordObservation = (record: Readonly<Record<string, number>>): string =>
  observationList(
    Object.entries(record)
      .sort(([left], [right]) => compareManagedText(left, right))
      .flatMap(([key, value]) => [observationValue(key), observationValue(value)]),
  );

/** Canonical, injective fingerprint used to CAS a discovery report. */
export const discoveryObservation = (report: ManagedWorkspaceDiscovery): string => {
  const transitionObservation = (transition: ManagedIdentityTransitionRecord) =>
    observationList([
      observationValue(transition.id),
      observationValue(transition.kind),
      observationValue(transition.phase),
      observationValue(transition.projectId),
      observationValue(transition.checkoutId),
      observationValue(transition.contextId),
      observationValue(transition.branch),
      observationValue(transition.path),
      observationValue(transition.projectIdentityLocation),
      observationValue(transition.expectedGitValue),
      observationValue(transition.targetGitValue),
      observationValue(transition.expectedOwnerBranch),
      observationValue(transition.createdAt),
      observationValue(transition.updatedAt),
    ]);
  const locationObservation = (location: ManagedWorkspaceDiscovery["locations"][number]) =>
    observationList([
      observationValue(location.id),
      observationValue(location.checkoutId),
      observationValue(location.canonicalPath),
      observationValue(location.state),
      observationValue(location.reboundFromLocationId),
      observationValue(location.lastSeenAt),
    ]);
  const stackObservation = (stack: ManagedWorkspaceDiscovery["stacks"][number]) =>
    observationList([
      observationValue(stack.id),
      observationValue(stack.projectId),
      observationValue(stack.checkoutId),
      observationValue(stack.contextId),
      observationValue(stack.name),
      observationValue(stack.status),
      observationValue(stack.lifecycle),
      observationValue(stack.runtimeRequest),
      observationValue(stack.runtime),
      observationValue(stack.paths.root),
      observationValue(stack.paths.data),
      observationValue(stack.paths.logs),
      observationValue(stack.paths.runtime),
      observationList(
        sortedBy(stack.ports, (port) => `${port.key}\0${port.port}\0${port.intent}`).map((port) =>
          observationList([
            observationValue(port.key),
            observationValue(port.port),
            observationValue(port.intent),
          ]),
        ),
      ),
      stringRecordObservation(stack.serviceVersions),
      observationValue(stack.runtimeMetadata.pid),
      observationValue(stack.runtimeMetadata.socketPath),
      numberRecordObservation(stack.runtimeMetadata.processIds),
      stringRecordObservation(stack.runtimeMetadata.containerIds),
      observationValue(stack.configFingerprint),
      observationValue(stack.credentialsReference),
      observationValue(stack.createdAt),
      observationValue(stack.updatedAt),
      observationValue(stack.tombstonedAt),
      observationValue(stack.checkoutKind),
      observationValue(stack.canonicalPath),
      observationValue(stack.contextKind),
      observationValue(stack.contextLocator),
    ]);
  const operationObservation = (operation: ManagedOperationRecord) =>
    observationList([
      observationValue(operation.token),
      observationValue(operation.stackId),
      observationValue(operation.kind),
      observationValue(operation.status),
      observationValue(operation.ownerPid),
      observationValue(operation.startedAt),
      observationValue(operation.finishedAt),
      observationValue(operation.error),
    ]);
  const recoveryObservation = (recovery: ManagedRecoveryOperation) =>
    observationList([
      observationValue(recovery.operation),
      observationValue("checkoutId" in recovery ? recovery.checkoutId : undefined),
      observationValue("contextId" in recovery ? recovery.contextId : undefined),
      observationValue("branch" in recovery ? recovery.branch : undefined),
      observationValue("path" in recovery ? recovery.path : undefined),
      observationList(
        "recordIds" in recovery
          ? [...recovery.recordIds].sort(compareManagedText).map(observationValue)
          : [],
      ),
    ]);
  return observationList([
    observationValue(report.state),
    observationValue(report.workspace.checkoutKind),
    observationValue(report.workspace.canonicalPath),
    observationValue(report.workspace.workspaceRoot),
    observationValue(report.workspace.projectIdentityLocation),
    observationValue(report.workspace.checkoutIdentityLocation),
    observationValue(report.context.kind),
    observationValue(report.context.branch),
    observationValue(report.context.commit),
    observationValue(report.contextDescriptor.kind),
    observationValue(
      report.contextDescriptor.kind === "branch" ? report.contextDescriptor.locator : undefined,
    ),
    observationValue(report.identity.projectId),
    observationValue(report.identity.checkoutId),
    observationValue(report.identity.contextId),
    observationValue(report.ordinaryMarker?.path),
    observationValue(report.ordinaryMarker?.present),
    observationValue(report.ordinaryMarker?.tracked),
    observationValue(report.ordinaryMarker?.identity?.projectId),
    observationValue(report.ordinaryMarker?.identity?.checkoutId),
    observationValue(report.ordinaryMarker?.identity?.contextId),
    observationList(
      sortedBy(
        report.folderToGitClaims,
        (claim) =>
          `${claim.projectId}\0${claim.checkoutId}\0${claim.contextId}\0${claim.canonicalPath}`,
      ).map((claim) =>
        observationList([
          observationValue(claim.projectId),
          observationValue(claim.checkoutId),
          observationValue(claim.contextId),
          observationValue(claim.canonicalPath),
        ]),
      ),
    ),
    observationValue(report.registryContextId),
    observationList(sortedBy(report.stacks, (stack) => stack.id).map(stackObservation)),
    observationList(sortedBy(report.locations, (location) => location.id).map(locationObservation)),
    observationList(
      sortedBy(report.conflictingLocations ?? [], (location) => location.id).map(
        locationObservation,
      ),
    ),
    observationValue(report.ownerEvidence?.contextId),
    observationValue(report.ownerEvidence?.authoritativeOwnerBranch),
    observationList(
      sortedBy(
        report.ownerEvidence?.claims ?? [],
        (claim) => `${claim.branch}\0${claim.contextId}\0${claim.live}`,
      ).map((claim) =>
        observationList([
          observationValue(claim.branch),
          observationValue(claim.contextId),
          observationValue(claim.live),
        ]),
      ),
    ),
    observationList(
      sortedBy(report.activeOperations, (operation) => operation.token).map(operationObservation),
    ),
    report.activeTransition === undefined
      ? observationValue(undefined)
      : transitionObservation(report.activeTransition),
    observationList([...report.conflicts].sort(compareManagedText).map(observationValue)),
    observationList([...report.warnings].sort(compareManagedText).map(observationValue)),
    observationList(
      sortedBy(report.recoveryOperations, recoveryObservation).map(recoveryObservation),
    ),
    observationList(
      [...(report.inaccessiblePaths ?? [])].sort(compareManagedText).map(observationValue),
    ),
    observationList(
      sortedBy(
        report.historicalPathEvidence ?? [],
        (evidence) => `${evidence.path}\0${evidence.locationState}\0${evidence.probe}`,
      ).map((evidence) =>
        observationList([
          observationValue(evidence.path),
          observationValue(evidence.locationState),
          observationValue(evidence.probe),
        ]),
      ),
    ),
  ]);
};
