import {
  type OutputShape,
  shapeAny,
  shapeBool,
  shapeMap,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTomlListWrapper,
} from "../../command-internal/struct-output.encoders.ts";

/**
 * Struct spec shared by `sso show`, `sso add`, `sso update`, `sso remove`,
 * and (as list items) `sso list`, driving `-o yaml` / `-o toml` key casing.
 */
export const SSO_PROVIDER_RESPONSE_SHAPE: OutputShape = shapeStruct([
  ["created_at", shapePtr(shapeString)],
  [
    "domains",
    shapePtr(
      shapeSlice(
        shapeStruct([
          ["created_at", shapePtr(shapeString)],
          ["domain", shapePtr(shapeString)],
          ["updated_at", shapePtr(shapeString)],
        ]),
      ),
    ),
  ],
  ["id", shapeString],
  [
    "saml",
    shapePtr(
      shapeStruct([
        [
          "attribute_mapping",
          shapePtr(
            shapeStruct([
              [
                "keys",
                shapeMap(
                  shapeStruct([
                    ["array", shapePtr(shapeBool)],
                    ["default", shapeAny],
                    ["name", shapePtr(shapeString)],
                    ["names", shapePtr(shapeSlice(shapeString))],
                  ]),
                ),
              ],
            ]),
          ),
        ],
        ["entity_id", shapeString],
        ["metadata_url", shapePtr(shapeString)],
        ["metadata_xml", shapePtr(shapeString)],
        ["name_id_format", shapePtr(shapeString)],
      ]),
    ),
  ],
  ["updated_at", shapePtr(shapeString)],
]);

/** `sso list` wraps the provider structs in a single lowercase `providers` key. */
export const SSO_PROVIDERS_WRAPPER_SHAPE: OutputShape = shapeTomlListWrapper(
  "providers",
  SSO_PROVIDER_RESPONSE_SHAPE,
);
