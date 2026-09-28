/** The stack fields that name a container and group it for Docker Desktop/OrbStack. */
interface ContainerIdentityInput {
  readonly stackId: string;
  readonly service?: string;
  readonly project?: string;
}

const nameSegment = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_.-]+/gu, "-").slice(0, 40);

// Compose project names allow only lowercase letters, digits, dashes, and underscores.
const composeSegment = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "-")
    .slice(0, 40);

/** Names a container and sets compose grouping labels; one-shots get a `-task` segment. */
export const identifyContainer = (spec: ContainerIdentityInput, token: string, oneOff: boolean) => {
  const project = spec.project === undefined ? undefined : nameSegment(spec.project);
  const service = spec.service === undefined ? undefined : nameSegment(spec.service);
  const name = [
    "supabase",
    project,
    service,
    oneOff ? "task" : undefined,
    token.replaceAll("-", "").slice(0, 12),
  ]
    .filter((segment): segment is string => segment !== undefined && segment.length > 0)
    .join("-");
  const composeProject = [
    "supabase",
    spec.project === undefined ? "stack" : composeSegment(spec.project) || "stack",
    spec.stackId.slice(0, 12).toLowerCase(),
  ].join("-");
  return { name, composeProject, composeService: service ?? "task" };
};
