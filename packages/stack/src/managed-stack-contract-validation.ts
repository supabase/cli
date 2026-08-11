import type {
  ManagedStackContractJson,
  ManagedStackContractScenario,
} from "./managed-stack-contract.ts";

export const validateManagedStackContractFixtures = (
  fixtures: ReadonlyArray<ManagedStackContractScenario>,
): ReadonlyArray<string> => {
  const errors: Array<string> = [];
  const scenarioIds = new Set<string>();

  for (const scenario of fixtures) {
    if (scenarioIds.has(scenario.id)) {
      errors.push(`${scenario.id}: duplicate scenario ID`);
    }
    scenarioIds.add(scenario.id);

    if (!scenario.id.startsWith(`${scenario.area}.`)) {
      errors.push(`${scenario.id}: ID must start with ${scenario.area}.`);
    }
    if (scenario.title.trim().length === 0) {
      errors.push(`${scenario.id}: title is required`);
    }
    if (scenario.given.length === 0) {
      errors.push(`${scenario.id}: at least one given fact is required`);
    }

    if (scenario.when.interface === "cli" || scenario.when.interface === "git") {
      if (scenario.when.argv.length === 0) {
        errors.push(`${scenario.id}: argv must contain a public command`);
      }
      if (scenario.when.cwd.trim().length === 0) {
        errors.push(`${scenario.id}: cwd is required for command scenarios`);
      }
    } else if (scenario.when.method.trim().length === 0) {
      errors.push(`${scenario.id}: public API method is required`);
    }

    const { output } = scenario.expected;
    if (output.human === undefined && output.json === undefined && output.api === undefined) {
      errors.push(`${scenario.id}: at least one observable output is required`);
    }

    if (scenario.expected.outcome === "error") {
      if (scenario.expected.error === undefined) {
        errors.push(`${scenario.id}: error outcome requires structured error metadata`);
      } else if (scenario.expected.error.recovery.length === 0) {
        errors.push(`${scenario.id}: error outcome requires recovery guidance`);
      }
    } else if (scenario.expected.error !== undefined) {
      errors.push(`${scenario.id}: non-error outcome cannot include error metadata`);
    }

    if (scenario.expected.warning !== undefined) {
      if (scenario.expected.outcome === "error") {
        errors.push(`${scenario.id}: error outcome cannot also include warning metadata`);
      }
      if (scenario.expected.warning.recovery.length === 0) {
        errors.push(`${scenario.id}: warning metadata requires recovery guidance`);
      }
    }

    for (const diagnostic of [scenario.expected.error, scenario.expected.warning]) {
      if (diagnostic !== undefined && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(diagnostic.code)) {
        errors.push(
          `${scenario.id}: diagnostic code ${diagnostic.code} must use SCREAMING_SNAKE_CASE`,
        );
      }
    }

    const hasMutation =
      scenario.expected.writes.length > 0 || scenario.expected.runtimeEffects.length > 0;
    if (scenario.expected.outcome === "report" && hasMutation) {
      errors.push(`${scenario.id}: report outcome must not mutate state`);
    }
    if (scenario.expected.outcome === "error" && hasMutation) {
      const isBootstrapRollback = scenario.expected.error?.code === "LEGACY_BOOTSTRAP_FAILED";
      const containsOnlyRollbackCleanup =
        scenario.expected.writes.every(
          (write) => write.target === "managed-state" && write.operation === "delete",
        ) && scenario.expected.runtimeEffects.every((effect) => effect.operation === "delete");
      if (!isBootstrapRollback || !containsOnlyRollbackCleanup) {
        errors.push(`${scenario.id}: error outcome must not mutate state outside rollback cleanup`);
      }
    }

    const declaredIds = new Set<string>();
    for (const fact of scenario.given) {
      switch (fact.kind) {
        case "branch":
          declaredIds.add(fact.contextId);
          break;
        case "checkout":
          declaredIds.add(fact.projectId);
          declaredIds.add(fact.checkoutId);
          break;
        case "credential-state":
          declaredIds.add(fact.valuesId);
          if (fact.previousValuesId !== undefined) {
            declaredIds.add(fact.previousValuesId);
          }
          break;
        case "direct-stack-state":
          declaredIds.add(fact.handle);
          for (const root of fact.temporaryRoots) {
            declaredIds.add(root.stateId);
          }
          break;
        case "identity-claim":
          declaredIds.add(fact.id);
          break;
        case "identity-marker":
          declaredIds.add(fact.markerId);
          declaredIds.add(fact.projectId);
          declaredIds.add(fact.checkoutId);
          declaredIds.add(fact.contextId);
          break;
        case "managed-record":
        case "managed-target":
        case "operation-result":
        case "persisted-runtime":
          declaredIds.add(fact.stackId);
          break;
        case "occupied-port":
          if (fact.ownerId !== undefined) {
            declaredIds.add(fact.ownerId);
          }
          break;
        case "port-assignment":
          declaredIds.add(fact.stackId);
          break;
        case "stack":
          declaredIds.add(fact.contextId);
          declaredIds.add(fact.stackId);
          break;
        default:
          break;
      }
    }

    for (const write of scenario.expected.writes) {
      if (write.id.trim().length === 0) {
        errors.push(`${scenario.id}: write ID is required`);
        continue;
      }
      if (
        write.operation === "copy" ||
        write.operation === "create" ||
        write.operation === "publish"
      ) {
        declaredIds.add(write.id);
      }

      if (write.target === "identity-marker") {
        declaredIds.add(write.projectId);
        declaredIds.add(write.checkoutId);
        declaredIds.add(write.contextId);
      }
    }
    for (const write of scenario.expected.writes) {
      if (
        write.operation !== "copy" &&
        write.operation !== "create" &&
        write.operation !== "publish" &&
        !declaredIds.has(write.id)
      ) {
        errors.push(
          `${scenario.id}: ${write.target} ${write.operation} references undeclared ID ${write.id}`,
        );
      }
    }

    if (scenario.expected.selection !== undefined) {
      for (const id of [
        scenario.expected.selection.projectId,
        scenario.expected.selection.checkoutId,
        scenario.expected.selection.contextId,
        scenario.expected.selection.stackId,
      ]) {
        if (!declaredIds.has(id)) {
          errors.push(`${scenario.id}: selection references undeclared ID ${id}`);
        }
      }
    }

    for (const effect of scenario.expected.runtimeEffects) {
      if (effect.stackId.trim().length === 0) {
        errors.push(`${scenario.id}: runtime effect stack ID is required`);
        continue;
      }
      if (!declaredIds.has(effect.stackId)) {
        errors.push(`${scenario.id}: runtime effect references undeclared ID ${effect.stackId}`);
      }

      const hasWrite = scenario.expected.writes.some((write) => {
        if (write.id !== effect.stackId) {
          return false;
        }
        switch (effect.operation) {
          case "copy":
            return write.target === "managed-state" && write.operation === "copy";
          case "delete":
            return write.target === "managed-state" && write.operation === "delete";
          case "start":
            return write.target === "runtime-state" && write.operation === "start";
          case "stop":
            return (
              write.target === "runtime-state" &&
              (write.operation === "delete" || write.operation === "update")
            );
        }
      });
      if (!hasWrite) {
        errors.push(
          `${scenario.id}: ${effect.operation} runtime effect requires a matching state write`,
        );
      }
    }

    for (const write of scenario.expected.writes) {
      const requiredRuntimeOperation =
        write.target === "runtime-state" && write.operation === "start"
          ? "start"
          : write.target === "runtime-state" &&
              (write.operation === "delete" || write.operation === "update")
            ? "stop"
            : write.target === "managed-state" && write.operation === "copy"
              ? "copy"
              : write.target === "managed-state" && write.operation === "delete"
                ? "delete"
                : undefined;
      if (
        requiredRuntimeOperation !== undefined &&
        !scenario.expected.runtimeEffects.some(
          (effect) => effect.operation === requiredRuntimeOperation && effect.stackId === write.id,
        )
      ) {
        errors.push(
          `${scenario.id}: ${write.target} ${write.operation} requires a matching runtime effect`,
        );
      }
    }

    const checkProjection = (
      projection: Readonly<Record<string, ManagedStackContractJson>> | undefined,
      key: string,
      expected: ManagedStackContractJson,
    ): void => {
      if (projection?.[key] !== undefined && projection[key] !== expected) {
        errors.push(`${scenario.id}: projected ${key} disagrees with the managed result`);
      }
    };

    if (output.json !== undefined && output.json.outcome === undefined) {
      errors.push(`${scenario.id}: JSON projection requires an outcome`);
    }
    const diagnosticCode = scenario.expected.error?.code ?? scenario.expected.warning?.code;
    if (
      output.json !== undefined &&
      diagnosticCode !== undefined &&
      output.json.code === undefined
    ) {
      errors.push(`${scenario.id}: JSON projection requires a code`);
    }
    for (const projection of [output.json, output.api]) {
      checkProjection(projection, "outcome", scenario.expected.outcome);
      if (diagnosticCode !== undefined) {
        checkProjection(projection, "code", diagnosticCode);
      }
    }

    const selection = scenario.expected.selection;
    if (selection !== undefined) {
      checkProjection(output.json, "project_id", selection.projectId);
      checkProjection(output.json, "checkout_id", selection.checkoutId);
      checkProjection(output.json, "context_id", selection.contextId);
      checkProjection(output.json, "stack_id", selection.stackId);
      checkProjection(output.json, "stack_name", selection.stackName);
      checkProjection(output.api, "projectId", selection.projectId);
      checkProjection(output.api, "checkoutId", selection.checkoutId);
      checkProjection(output.api, "contextId", selection.contextId);
      checkProjection(output.api, "stackId", selection.stackId);
      checkProjection(output.api, "stackName", selection.stackName);
      checkProjection(output.human?.fields, "projectId", selection.projectId);
      checkProjection(output.human?.fields, "checkoutId", selection.checkoutId);
      checkProjection(output.human?.fields, "contextId", selection.contextId);
      checkProjection(output.human?.fields, "stackId", selection.stackId);
      checkProjection(output.human?.fields, "stack", selection.stackName);
      checkProjection(output.human?.fields, "stackName", selection.stackName);
    }

    const expectedRecovery =
      scenario.expected.error?.recovery ?? scenario.expected.warning?.recovery;
    if (
      output.human !== undefined &&
      expectedRecovery !== undefined &&
      (output.human.recovery === undefined ||
        output.human.recovery.length !== expectedRecovery.length ||
        output.human.recovery.some((step, index) => step !== expectedRecovery[index]))
    ) {
      errors.push(`${scenario.id}: human recovery disagrees with the managed result`);
    }
    const jsonRecovery = output.json?.recovery;
    if (
      output.json !== undefined &&
      expectedRecovery !== undefined &&
      (!Array.isArray(jsonRecovery) ||
        jsonRecovery.length !== expectedRecovery.length ||
        jsonRecovery.some((step, index) => step !== expectedRecovery[index]))
    ) {
      errors.push(`${scenario.id}: JSON recovery disagrees with the managed result`);
    }
  }

  return errors;
};
