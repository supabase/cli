import {
  type GoType,
  goAny,
  goBool,
  goMap,
  goPtr,
  goSlice,
  goString,
  goStruct,
  goTomlListWrapper,
} from "../../command-internal/go-struct-output.encoders.ts";

/**
 * Struct spec shared by `sso show`, `sso add`, `sso update`, `sso remove`,
 * and (as list items) `sso list`, driving `-o yaml` / `-o toml` key casing.
 */
export const GO_SSO_PROVIDER_RESPONSE: GoType = goStruct([
  ["created_at", goPtr(goString)],
  [
    "domains",
    goPtr(
      goSlice(
        goStruct([
          ["created_at", goPtr(goString)],
          ["domain", goPtr(goString)],
          ["updated_at", goPtr(goString)],
        ]),
      ),
    ),
  ],
  ["id", goString],
  [
    "saml",
    goPtr(
      goStruct([
        [
          "attribute_mapping",
          goPtr(
            goStruct([
              [
                "keys",
                goMap(
                  goStruct([
                    ["array", goPtr(goBool)],
                    ["default", goAny],
                    ["name", goPtr(goString)],
                    ["names", goPtr(goSlice(goString))],
                  ]),
                ),
              ],
            ]),
          ),
        ],
        ["entity_id", goString],
        ["metadata_url", goPtr(goString)],
        ["metadata_xml", goPtr(goString)],
        ["name_id_format", goPtr(goString)],
      ]),
    ),
  ],
  ["updated_at", goPtr(goString)],
]);

/** `sso list` wraps the provider structs in a single lowercase `providers` key. */
export const GO_SSO_PROVIDERS_WRAPPER: GoType = goTomlListWrapper(
  "providers",
  GO_SSO_PROVIDER_RESPONSE,
);
