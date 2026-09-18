import {
  PORT_FIELD_PROTOCOL,
  type PortField,
  type StackEndpoint,
  type StackStatus,
} from "../public/Status.ts";
import type { PersistedStackState } from "../state/StackState.ts";

const INSTANCE_BINDINGS: Readonly<Record<string, PortField>> = {
  sql: "database",
  inspector: "functionsInspector",
  studio: "studio",
  pooler: "pooler",
  mailUi: "mailUi",
  smtp: "smtp",
  pop3: "pop3",
};

export const portFieldForInstanceBinding = (binding: string): PortField | undefined =>
  INSTANCE_BINDINGS[binding];

const endpointFor = (
  field: PortField,
  assignment: { readonly address: string; readonly port: number },
): StackEndpoint => {
  const protocol = PORT_FIELD_PROTOCOL[field];
  return {
    protocol,
    address: assignment.address,
    port: assignment.port,
    url: `${protocol}://${assignment.address}:${assignment.port}`,
  };
};

/** Projects stack API and designated default-instance endpoints for public status. */
export const statusEndpointsFor = (state: PersistedStackState): StackStatus["endpoints"] => {
  const endpoints: Partial<Record<PortField, StackEndpoint>> = {};
  const api = state.ports.find(
    (assignment) => assignment.owner === "stack" && assignment.binding === "api",
  );
  if (api !== undefined && state.listeners.api?.enabled !== false)
    endpoints.api = endpointFor("api", api);

  for (const assignment of state.ports) {
    if (assignment.owner !== "instance") continue;
    const instance = state.registry.instances.find(({ id }) => id === assignment.instanceId);
    if (instance === undefined || instance.config.enabled === false) continue;
    if (state.registry.defaultInstanceIds[instance.service] !== instance.id) continue;
    const field = portFieldForInstanceBinding(assignment.binding);
    if (field !== undefined) endpoints[field] = endpointFor(field, assignment);
  }
  return endpoints;
};
