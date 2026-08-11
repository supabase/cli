import { isDeepStrictEqual } from "node:util";
import type {
  ManagedStackContractFact,
  ManagedStackContractJson,
  ManagedStackContractScenario,
} from "./managed-stack-contract.ts";

const factPrimaryId = (fact: ManagedStackContractFact): string | undefined => {
  switch (fact.kind) {
    case "checkout":
      return fact.checkoutId;
    case "credential-state":
      return fact.valuesId;
    case "direct-stack-state":
      return fact.handle;
    case "identity-claim":
      return `${fact.scope}:${fact.id}`;
    case "identity-marker":
      return fact.markerId;
    case "managed-record":
    case "managed-target":
    case "operation-result":
    case "persisted-runtime":
    case "stack":
      return fact.stackId;
    case "port-assignment":
      return `${fact.stackId}:${fact.key}`;
    default:
      return undefined;
  }
};

const containsNonFiniteNumber = (value: ManagedStackContractJson | undefined): boolean => {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsNonFiniteNumber);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsNonFiniteNumber);
  }
  return false;
};

const snakeToCamel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());

export const validateManagedStackContractFixtures = (
  fixtures: ReadonlyArray<ManagedStackContractScenario>,
): ReadonlyArray<string> => {
  const errors: Array<string> = [];
  const knownScenarioIds = new Set(fixtures.map((scenario) => scenario.id));
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
      if (scenario.when.argv.length === 0 || scenario.when.argv[0]?.trim().length === 0) {
        errors.push(`${scenario.id}: argv must start with a public command`);
      }
      if (scenario.when.cwd.trim().length === 0) {
        errors.push(`${scenario.id}: cwd is required for command scenarios`);
      }
      const givenPaths = scenario.given.flatMap((fact) =>
        fact.kind === "workspace" || fact.kind === "checkout" ? [fact.path] : [],
      );
      if (givenPaths.length > 0 && !givenPaths.includes(scenario.when.cwd)) {
        errors.push(
          `${scenario.id}: cwd ${scenario.when.cwd} does not match a given workspace or checkout path`,
        );
      }
    } else {
      if (scenario.when.method.trim().length === 0) {
        errors.push(`${scenario.id}: public API method is required`);
      }
      const referencedScenarioId = scenario.when.input.scenarioId;
      if (
        referencedScenarioId !== undefined &&
        (typeof referencedScenarioId !== "string" || !knownScenarioIds.has(referencedScenarioId))
      ) {
        errors.push(`${scenario.id}: references unknown scenario ID ${referencedScenarioId}`);
      }
      if (containsNonFiniteNumber(scenario.when.input)) {
        errors.push(`${scenario.id}: public API input contains a non-finite number`);
      }
    }

    const { output } = scenario.expected;
    if (output.human === undefined && output.json === undefined && output.api === undefined) {
      errors.push(`${scenario.id}: at least one observable output is required`);
    }
    if (output.human !== undefined && output.human.summary.trim().length === 0) {
      errors.push(`${scenario.id}: human summary is required`);
    }
    for (const key of Object.keys(output.json ?? {})) {
      if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key)) {
        errors.push(`${scenario.id}: JSON projection key ${key} must use snake_case`);
      }
    }
    for (const key of Object.keys(output.api ?? {})) {
      if (key.includes("_")) {
        errors.push(`${scenario.id}: API projection key ${key} must not use snake_case`);
      }
    }
    const jsonValues: ReadonlyArray<
      readonly [label: string, value: ManagedStackContractJson | undefined]
    > = [
      ["managed detail data", scenario.expected.details],
      ["JSON projection", output.json],
      ["API projection", output.api],
    ];
    for (const [label, value] of jsonValues) {
      if (containsNonFiniteNumber(value)) {
        errors.push(`${scenario.id}: ${label} contains a non-finite number`);
      }
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
      if (diagnostic === undefined) {
        continue;
      }
      if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(diagnostic.code)) {
        errors.push(
          `${scenario.id}: diagnostic code ${diagnostic.code} must use SCREAMING_SNAKE_CASE`,
        );
      }
      if (diagnostic.message.trim().length === 0) {
        errors.push(`${scenario.id}: diagnostic message is required`);
      }
      if (diagnostic.recovery.some((step) => step.trim().length === 0)) {
        errors.push(`${scenario.id}: diagnostic recovery steps must not be blank`);
      }
    }

    const hasMutation =
      scenario.expected.writes.length > 0 || scenario.expected.runtimeEffects.length > 0;
    if (
      (scenario.expected.outcome === "report" || scenario.expected.outcome === "no-op") &&
      hasMutation
    ) {
      errors.push(`${scenario.id}: ${scenario.expected.outcome} outcome must not mutate state`);
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
    const factsByPrimaryId = new Map<string, ManagedStackContractFact>();
    const declareId = (id: string): void => {
      if (id.trim().length === 0) {
        errors.push(`${scenario.id}: declared ID is required`);
      } else {
        declaredIds.add(id);
      }
    };
    for (const fact of scenario.given) {
      const primaryId = factPrimaryId(fact);
      if (primaryId !== undefined) {
        const factKey = `${fact.kind}:${primaryId}`;
        const previousFact = factsByPrimaryId.get(factKey);
        if (previousFact !== undefined && !isDeepStrictEqual(previousFact, fact)) {
          errors.push(`${scenario.id}: conflicting ${fact.kind} facts for ID ${primaryId}`);
        } else if (previousFact === undefined) {
          factsByPrimaryId.set(factKey, fact);
        }
      }

      switch (fact.kind) {
        case "branch":
          declareId(fact.contextId);
          break;
        case "checkout":
          declareId(fact.projectId);
          declareId(fact.checkoutId);
          break;
        case "credential-state":
          declareId(fact.valuesId);
          if (fact.previousValuesId !== undefined) {
            declareId(fact.previousValuesId);
          }
          break;
        case "direct-stack-state":
          declareId(fact.handle);
          for (const root of fact.temporaryRoots) {
            declareId(root.stateId);
          }
          break;
        case "identity-claim":
          declareId(fact.id);
          break;
        case "identity-marker":
          declareId(fact.markerId);
          declareId(fact.projectId);
          declareId(fact.checkoutId);
          declareId(fact.contextId);
          break;
        case "managed-record":
        case "managed-target":
        case "operation-result":
        case "persisted-runtime":
          declareId(fact.stackId);
          break;
        case "occupied-port":
          if (fact.ownerId !== undefined) {
            declareId(fact.ownerId);
          }
          break;
        case "port-assignment":
          declareId(fact.stackId);
          break;
        case "stack":
          declareId(fact.contextId);
          declareId(fact.stackId);
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
        declareId(write.id);
      }

      if (write.target === "identity-marker") {
        declareId(write.projectId);
        declareId(write.checkoutId);
        declareId(write.contextId);
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

    const selection = scenario.expected.selection;
    if (selection !== undefined) {
      for (const id of [
        selection.projectId,
        selection.checkoutId,
        selection.contextId,
        selection.stackId,
      ]) {
        if (!declaredIds.has(id)) {
          errors.push(`${scenario.id}: selection references undeclared ID ${id}`);
        }
      }
      const selectedStackFact = factsByPrimaryId.get(`stack:${selection.stackId}`);
      if (selectedStackFact?.kind === "stack" && selectedStackFact.name !== selection.stackName) {
        errors.push(
          `${scenario.id}: selected stack name ${selection.stackName} disagrees with stack ${selection.stackId}`,
        );
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
      if (projection?.[key] !== undefined && !isDeepStrictEqual(projection[key], expected)) {
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
    for (const [key, value] of Object.entries(scenario.expected.details ?? {})) {
      checkProjection(output.json, key, value);
      checkProjection(output.api, key, value);
      const apiKey = snakeToCamel(key);
      if (apiKey !== key) {
        checkProjection(output.api, apiKey, value);
      }
    }

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
