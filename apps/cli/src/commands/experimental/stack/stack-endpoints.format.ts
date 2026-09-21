import type { Observation } from "@supabase/stack/effect";

const endpointUrl = (endpoint: Observation["endpoints"][number]) =>
  `${endpoint.protocol}://${endpoint.host}:${endpoint.port}`;

export const endpointReports = (observation: Observation | undefined) =>
  Object.fromEntries(
    (observation?.endpoints ?? []).map((endpoint) => [
      endpoint.name,
      {
        protocol: endpoint.protocol,
        address: endpoint.host,
        port: endpoint.port,
        url: endpointUrl(endpoint),
      },
    ]),
  );
