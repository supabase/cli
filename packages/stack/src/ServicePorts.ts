import type { PortField } from "./PortAllocator.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";

export const allocatedPortFieldsForConfig = (
  config: ResolvedStackConfig,
): ReadonlyArray<PortField> => {
  const fields: Array<PortField> = ["apiPort", "dbPort"];
  if (config.postgrest !== false) fields.push("postgrestPort", "postgrestAdminPort");
  if (config.auth !== false) fields.push("authPort");
  if (config.edgeRuntime !== false) fields.push("edgeRuntimePort", "edgeRuntimeInspectorPort");
  if (config.realtime !== false) fields.push("realtimePort");
  if (config.storage !== false) fields.push("storagePort");
  if (config.imgproxy !== false) fields.push("imgproxyPort");
  if (config.mailpit !== false) fields.push("mailpitPort", "mailpitSmtpPort", "mailpitPop3Port");
  if (config.pgmeta !== false) fields.push("pgmetaPort");
  if (config.studio !== false) fields.push("studioPort");
  if (config.analytics !== false) fields.push("analyticsPort");
  if (config.pooler !== false) fields.push("poolerPort", "poolerApiPort");
  return fields;
};

export const portFieldsForService = (name: string): ReadonlyArray<PortField> => {
  switch (name) {
    case "postgres":
      return ["dbPort"];
    case "postgrest":
      return ["postgrestPort", "postgrestAdminPort"];
    case "auth":
      return ["authPort"];
    case "edge-runtime":
      return ["edgeRuntimePort", "edgeRuntimeInspectorPort"];
    case "realtime":
      return ["realtimePort"];
    case "storage":
      return ["storagePort"];
    case "imgproxy":
      return ["imgproxyPort"];
    case "mailpit":
      return ["mailpitPort", "mailpitSmtpPort", "mailpitPop3Port"];
    case "pgmeta":
      return ["pgmetaPort"];
    case "studio":
      return ["studioPort"];
    case "analytics":
      return ["analyticsPort"];
    case "pooler":
      return ["poolerPort", "poolerApiPort"];
    default:
      return [];
  }
};
