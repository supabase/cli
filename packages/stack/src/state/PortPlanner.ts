import { Effect, Schema } from "effect";
import { NetworkPortSchema } from "../public/Status.ts";
import { StackStateInvalidError } from "../public/Errors.ts";
import type {
  HostPortAssignment,
  PersistedStackState,
  PrivatePortAssignment,
} from "./StackState.ts";

const PORT_MIN = 20_000;
const PORT_MAX = 32_767;
const PORT_POOL_SIZE = PORT_MAX - PORT_MIN + 1;

type PortAssignment = HostPortAssignment | PrivatePortAssignment;
type SiblingState = Readonly<{ stackId: string; state: PersistedStackState }>;

const isValidPort = Schema.is(NetworkPortSchema);

const assignmentKey = (assignment: PortAssignment): string =>
  "owner" in assignment
    ? assignment.owner === "stack"
      ? `stack:${assignment.binding}`
      : `instance:${assignment.instanceId}:${assignment.binding}`
    : `private:${assignment.instanceId}:${assignment.workloadId}:${assignment.binding}`;

const assignmentField = (assignment: PortAssignment): string =>
  "owner" in assignment
    ? assignment.owner === "stack"
      ? assignment.binding
      : `${assignment.instanceId}:${assignment.binding}`
    : `${assignment.instanceId}:${assignment.workloadId}:${assignment.binding}`;

const assignmentIsExact = (assignment: PortAssignment): boolean =>
  "intent" in assignment && assignment.intent === "exact";

const portError = (message: string, field?: string) =>
  new StackStateInvalidError({
    message,
    code: "stable-port-plan",
    ...(field === undefined ? {} : { path: field }),
  });

const hashStart = (identity: string): number => {
  let hash = 2_166_136_261;
  for (const character of identity) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash) % PORT_POOL_SIZE;
};

const replacement = (assignment: PortAssignment, port: number): PortAssignment => ({
  ...assignment,
  port,
});

/**
 * Plans durable automatic bindings against sibling state while the caller holds the registry
 * transaction. Existing automatic assignments are retained whenever their claim is still free.
 */
export const planStablePorts = (
  stackId: string,
  state: PersistedStackState,
  siblings: ReadonlyArray<SiblingState>,
  previous?: PersistedStackState,
): Effect.Effect<PersistedStackState, StackStateInvalidError> =>
  Effect.gen(function* () {
    const occupied = new Set<number>();
    for (const sibling of siblings)
      for (const assignment of [...sibling.state.ports, ...sibling.state.privatePorts])
        occupied.add(assignment.port);

    const assignments: ReadonlyArray<PortAssignment> = [...state.ports, ...state.privatePorts];
    const previousByKey = new Map<string, PortAssignment>(
      previous === undefined
        ? []
        : [...previous.ports, ...previous.privatePorts].map((assignment) => [
            assignmentKey(assignment),
            assignment,
          ]),
    );
    const preferredPort = (assignment: PortAssignment): number => {
      const prior = previousByKey.get(assignmentKey(assignment));
      if (prior === undefined) return assignment.port;
      if ("owner" in assignment && assignment.intent === "exact") return assignment.port;
      return prior.port;
    };
    for (const assignment of assignments) {
      const prior = previousByKey.get(assignmentKey(assignment));
      if (prior === undefined || ("owner" in assignment && assignment.intent === "exact")) continue;
      if (occupied.has(prior.port))
        return yield* portError(
          `Previously published port ${prior.port} for ${assignmentField(assignment)} conflicts with another stack binding`,
          assignmentField(assignment),
        );
    }
    const reservedCandidatePorts = new Set<number>();
    for (const assignment of assignments) {
      const port = preferredPort(assignment);
      if (!occupied.has(port)) reservedCandidatePorts.add(port);
    }
    const planned = new Map<number, PortAssignment>();
    const results = new Map<number, PortAssignment>();
    const fresh = (assignment: PortAssignment, index: number): number => {
      const start = hashStart(`${stackId}:${assignmentKey(assignment)}:${index}`);
      for (let offset = 0; offset < PORT_POOL_SIZE; offset += 1) {
        const port = PORT_MIN + ((start + offset) % PORT_POOL_SIZE);
        if (!occupied.has(port) && !planned.has(port) && !reservedCandidatePorts.has(port))
          return port;
      }
      return -1;
    };

    const order = assignments
      .map((assignment, index) => ({ assignment, index }))
      .sort(
        (left, right) =>
          Number(assignmentIsExact(right.assignment)) - Number(assignmentIsExact(left.assignment)),
      );
    for (const { assignment, index } of order) {
      const field = assignmentField(assignment);
      const requestedPort = preferredPort(assignment);
      if (!isValidPort(requestedPort))
        return yield* portError(
          `Port ${requestedPort} for ${field} is outside the managed range`,
          field,
        );

      const ownCollision = planned.has(requestedPort);
      const siblingCollision = occupied.has(requestedPort);
      const collision = ownCollision || siblingCollision;
      if (!collision) {
        const retained =
          requestedPort === assignment.port ? assignment : replacement(assignment, requestedPort);
        planned.set(requestedPort, retained);
        results.set(index, retained);
        continue;
      }
      if (ownCollision)
        return yield* portError(
          `Port overlap: ${requestedPort} is claimed by multiple bindings in this plan`,
          field,
        );
      if (assignmentIsExact(assignment))
        return yield* portError(
          `Exact port ${requestedPort} for ${field} conflicts with another stack binding`,
          field,
        );
      const port = fresh(assignment, index);
      if (port < 0) return yield* portError(`No automatic port is available for ${field}`, field);
      const next = replacement(assignment, port);
      planned.set(port, next);
      results.set(index, next);
    }

    const ports: HostPortAssignment[] = [];
    for (let index = 0; index < state.ports.length; index += 1) {
      const assignment = results.get(index);
      if (assignment === undefined || !("owner" in assignment))
        return yield* portError("Stable port planner lost a public binding", String(index));
      ports.push(assignment);
    }
    const privatePorts: PrivatePortAssignment[] = [];
    for (let index = 0; index < state.privatePorts.length; index += 1) {
      const assignment = results.get(state.ports.length + index);
      if (assignment === undefined || "owner" in assignment)
        return yield* portError("Stable port planner lost a private binding", String(index));
      privatePorts.push(assignment);
    }

    return {
      ...state,
      ports,
      privatePorts,
    };
  });
