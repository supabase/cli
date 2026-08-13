import {
  type LegacyGoType,
  legacyGoAny,
  legacyGoBool,
  legacyGoMap,
  legacyGoPtr,
  legacyGoSlice,
  legacyGoString,
  legacyGoStruct,
  legacyGoTomlListWrapper,
} from "../../shared/legacy-go-struct-output.encoders.ts";

/**
 * Struct spec shared by `sso show`, `sso add`, `sso update`, `sso remove`,
 * and (as list items) `sso list`, driving `-o yaml` / `-o toml` key casing.
 */
export const LEGACY_GO_SSO_PROVIDER_RESPONSE: LegacyGoType = legacyGoStruct([
  ["created_at", legacyGoPtr(legacyGoString)],
  [
    "domains",
    legacyGoPtr(
      legacyGoSlice(
        legacyGoStruct([
          ["created_at", legacyGoPtr(legacyGoString)],
          ["domain", legacyGoPtr(legacyGoString)],
          ["updated_at", legacyGoPtr(legacyGoString)],
        ]),
      ),
    ),
  ],
  ["id", legacyGoString],
  [
    "saml",
    legacyGoPtr(
      legacyGoStruct([
        [
          "attribute_mapping",
          legacyGoPtr(
            legacyGoStruct([
              [
                "keys",
                legacyGoMap(
                  legacyGoStruct([
                    ["array", legacyGoPtr(legacyGoBool)],
                    ["default", legacyGoAny],
                    ["name", legacyGoPtr(legacyGoString)],
                    ["names", legacyGoPtr(legacyGoSlice(legacyGoString))],
                  ]),
                ),
              ],
            ]),
          ),
        ],
        ["entity_id", legacyGoString],
        ["metadata_url", legacyGoPtr(legacyGoString)],
        ["metadata_xml", legacyGoPtr(legacyGoString)],
        ["name_id_format", legacyGoPtr(legacyGoString)],
      ]),
    ),
  ],
  ["updated_at", legacyGoPtr(legacyGoString)],
]);

/**
 * `sso list` encodes `map[string]any{"providers": resp.JSON200.Items}`
 * (`list.go:35-37`) — a single lowercase key wrapping the provider structs,
 * which renders identically to a one-field tagged wrapper struct.
 */
export const LEGACY_GO_SSO_PROVIDERS_WRAPPER: LegacyGoType = legacyGoTomlListWrapper(
  "providers",
  LEGACY_GO_SSO_PROVIDER_RESPONSE,
);
