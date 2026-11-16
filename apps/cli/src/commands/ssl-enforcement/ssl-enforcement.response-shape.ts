import {
  type OutputShape,
  shapeBool,
  shapeStruct,
} from "../../command-internal/struct-output.encoders.ts";

/**
 * Type shape for the SSL enforcement response, used to drive `-o yaml`/`-o
 * toml` key casing. Shared by `ssl-enforcement get` and `ssl-enforcement
 * update`.
 */
export const SSL_ENFORCEMENT_RESPONSE_SHAPE: OutputShape = shapeStruct([
  ["appliedSuccessfully", shapeBool],
  ["currentConfig", shapeStruct([["database", shapeBool]])],
]);
