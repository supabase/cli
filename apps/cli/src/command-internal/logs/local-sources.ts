import { sharesApiEndpoint, type SavedStack } from "@supabase/stack/effect";

export const hasGatewayLogs = (definition: SavedStack): boolean => {
  const members = new Set(definition.composition.members.map(({ id }) => id));
  return definition.instances.some(
    ({ id, creation }) => members.has(id) && sharesApiEndpoint(creation),
  );
};
