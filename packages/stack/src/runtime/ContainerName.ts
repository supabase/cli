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

/** Groups a stack's containers, helpers included, as one compose project. */
export const composeProjectFor = (stackId: string, project: string | undefined): string =>
  [
    "supabase",
    project === undefined ? "stack" : composeSegment(project) || "stack",
    stackId.slice(0, 12).toLowerCase(),
  ].join("-");

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
  return {
    name,
    composeProject: composeProjectFor(spec.stackId, spec.project),
    composeService: service ?? "task",
  };
};
