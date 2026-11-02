import {
  type OutputShape,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTomlListWrapper,
} from "../../command-internal/struct-output.encoders.ts";

/** Struct shape for `-o yaml`/`-o toml` key casing, shared by `orgs list` and `orgs create`. */
export const ORGANIZATION_RESPONSE_SHAPE: OutputShape = shapeStruct([
  ["id", shapeString],
  ["name", shapeString],
  ["slug", shapeString],
]);

/** `orgs list -o yaml` encodes the bare organization list. */
export const ORGS_LIST_SHAPE: OutputShape = shapeSlice(ORGANIZATION_RESPONSE_SHAPE);

/** `orgs list -o toml` wraps the list under an `organizations` key. */
export const ORGS_TOML_WRAPPER_SHAPE: OutputShape = shapeTomlListWrapper(
  "organizations",
  ORGANIZATION_RESPONSE_SHAPE,
);
