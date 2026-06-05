import { describe, expect, it } from "vitest";
import { Result } from "effect";

import {
  buildInfoPayload,
  formatDomains,
  formatEntityId,
  formatMetadataSource,
  formatNameIdFormat,
  formatProtocol,
  formatSsoMetadataXml,
  formatSsoTimestamp,
  renderInfoMarkdown,
  renderListProviders,
  renderSingleProvider,
  toLegacySsoProviderView,
  validateUuid,
} from "./sso.format.ts";

describe("formatSsoTimestamp", () => {
  it("formats RFC3339 input as Go's `YYYY-MM-DD HH:MM:SS` (UTC, no suffix)", () => {
    expect(formatSsoTimestamp("2023-03-28T13:50:14.464Z")).toBe("2023-03-28 13:50:14");
  });

  it("returns an empty string for undefined input", () => {
    expect(formatSsoTimestamp(undefined)).toBe("");
  });

  it("returns the original string when the input is unparseable", () => {
    expect(formatSsoTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("formatProtocol", () => {
  it("returns `SAML 2.0` when saml metadata is present", () => {
    expect(formatProtocol({ entity_id: "x" })).toBe("SAML 2.0");
  });

  it("returns `unknown` when saml metadata is absent", () => {
    expect(formatProtocol(undefined)).toBe("unknown");
  });
});

describe("formatDomains", () => {
  it("joins multiple domains with `, `", () => {
    expect(formatDomains([{ domain: "example.com" }, { domain: "other.com" }])).toBe(
      "example.com, other.com",
    );
  });

  it("returns `-` for an empty list", () => {
    expect(formatDomains([])).toBe("-");
  });

  it("returns `-` for undefined domains", () => {
    expect(formatDomains(undefined)).toBe("-");
  });

  it("filters out missing domain fields", () => {
    expect(formatDomains([{ domain: "example.com" }, { domain: undefined }])).toBe("example.com");
  });
});

describe("formatEntityId / formatNameIdFormat / formatMetadataSource fallbacks", () => {
  it("formatEntityId returns `-` when saml or entity_id is missing", () => {
    expect(formatEntityId(undefined)).toBe("-");
    expect(formatEntityId({ entity_id: "" })).toBe("-");
  });

  it("formatNameIdFormat returns `-` when saml or name_id_format is missing", () => {
    expect(formatNameIdFormat(undefined)).toBe("-");
    expect(formatNameIdFormat({ entity_id: "x", name_id_format: "" })).toBe("-");
  });

  it("formatMetadataSource returns `FILE` when metadata_url is absent", () => {
    expect(formatMetadataSource(undefined)).toBe("FILE");
    expect(formatMetadataSource({ entity_id: "x" })).toBe("FILE");
    expect(formatMetadataSource({ entity_id: "x", metadata_url: "https://example.com" })).toBe(
      "https://example.com",
    );
  });
});

describe("validateUuid", () => {
  it("accepts canonical lowercase UUIDs", () => {
    const result = validateUuid("b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8");
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("accepts uppercase UUIDs (matches Go's `uuid.Parse` case-insensitivity)", () => {
    const result = validateUuid("B5AE62F9-EF1D-4F11-A02B-731C8BBB11E8");
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("accepts mixed-case UUIDs", () => {
    const result = validateUuid("B5ae62F9-eF1d-4F11-a02B-731C8bbb11E8");
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("rejects non-UUIDs with a Go-compatible message", () => {
    const result = validateUuid("not-a-uuid");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toBe(`identity provider ID "not-a-uuid" is not a UUID`);
    }
  });
});

describe("renderListProviders / renderSingleProvider markdown surface", () => {
  it("renders a list with header + data rows", () => {
    const out = renderListProviders([
      {
        id: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
        saml: { entity_id: "https://example.com" },
        domains: [{ domain: "example.com" }],
        created_at: "2023-03-28T13:50:14.464Z",
        updated_at: "2023-03-28T13:50:14.464Z",
      },
    ]);
    expect(out).toContain("TYPE");
    expect(out).toContain("IDENTITY PROVIDER ID");
    expect(out).toContain("0b0d48f6-878b-4190-88d7-2ca33ed800bc");
    expect(out).toContain("example.com");
    expect(out).toContain("2023-03-28 13:50:14");
  });

  it("renders a single provider with table + optional attribute mapping section", () => {
    const out = renderSingleProvider({
      id: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
      saml: {
        entity_id: "https://example.com",
        attribute_mapping: { keys: { a: { name: "xyz" } } },
        metadata_xml: '<?xml version="2.0"?>',
      },
      domains: [{ domain: "example.com" }],
      created_at: "2023-03-28T13:50:14.464Z",
    });
    expect(out).toContain("IDENTITY PROVIDER ID");
    expect(out).toContain("0b0d48f6-878b-4190-88d7-2ca33ed800bc");
    expect(out).toContain("## Attribute Mapping");
    expect(out).toContain("```json");
    expect(out).toContain("## SAML 2.0 Metadata XML");
    expect(out).toContain("```xml");
  });

  it("renders a single provider WITHOUT optional sections when none present", () => {
    const out = renderSingleProvider({
      id: "abc",
      created_at: "2023-03-28T13:50:14.464Z",
    });
    expect(out).not.toContain("## Attribute Mapping");
    expect(out).not.toContain("## SAML 2.0 Metadata XML");
  });

  // PARITY GUARD — do not "fix" this:
  // Go's `apps/cli-go/internal/sso/internal/render/render.go:140-143` populates
  // the `UPDATED AT (UTC)` row with `provider.CreatedAt`, not `provider.UpdatedAt`
  // — almost certainly a Go-side bug, but the legacy shell is a strict 1:1 port.
  // If you find yourself reaching to change line 194 of sso.format.ts because
  // "obviously UPDATED AT should use updated_at", this test will fail. Update
  // Go first, then this test, then the renderer — in that order.
  it("intentionally renders UPDATED AT using created_at (Go-bug parity guard)", () => {
    const out = renderSingleProvider({
      id: "abc",
      created_at: "2023-01-01T00:00:00Z",
      updated_at: "2099-12-31T23:59:59Z",
    });
    // CREATED row uses created_at:
    expect(out).toContain("CREATED AT (UTC)");
    expect(out).toContain("2023-01-01 00:00:00");
    // UPDATED row uses created_at (the bug), not updated_at:
    expect(out).not.toContain("2099-12-31 23:59:59");
  });
});

describe("buildInfoPayload + renderInfoMarkdown", () => {
  it("derives three URLs from the project ref", () => {
    const payload = buildInfoPayload("abcdefghijklmnopqrst");
    expect(payload).toEqual({
      acs_url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/sso/saml/acs",
      entity_id: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/sso/saml/metadata",
      relay_state: "https://abcdefghijklmnopqrst.supabase.co",
    });
  });

  it("renderInfoMarkdown interpolates ref into the three labels", () => {
    const out = renderInfoMarkdown("abcdefghijklmnopqrst");
    expect(out).toContain("Single sign-on URL (ACS URL)");
    expect(out).toContain("https://abcdefghijklmnopqrst.supabase.co/auth/v1/sso/saml/acs");
    expect(out).toContain("https://abcdefghijklmnopqrst.supabase.co/auth/v1/sso/saml/metadata");
    expect(out).toContain("https://abcdefghijklmnopqrst.supabase.co");
  });
});

describe("formatSsoMetadataXml (xmlfmt parity port)", () => {
  it("indents nested tags by depth × indent", () => {
    // Reference output captured by running go-xmlfmt v1.1.3
    // `FormatXML("<a><b><c/></b></a>", "  ", "  ")`.
    const out = formatSsoMetadataXml("<a><b><c/></b></a>", "  ", "  ");
    expect(out).toBe("  \n  <a>\n    <b>\n      <c/>\n    </b>\n  </a>");
  });

  it("keeps close-tags inline with content (e.g. <b>text</b>)", () => {
    // Reference: go-xmlfmt's `lastEndElem` flag suppresses the newline before
    // a closing tag whose preceding sibling was an opening tag with text.
    const out = formatSsoMetadataXml("<a><b>text</b></a>", "  ", "  ");
    expect(out).toBe("  \n  <a>\n    <b>text</b>\n  </a>");
  });

  it("handles the <?xml ?> declaration without descending", () => {
    const out = formatSsoMetadataXml(`<?xml version="1.0"?><a/>`, "  ", "  ");
    expect(out).toBe(`  \n  <?xml version="1.0"?>\n  <a/>`);
  });

  it("collapses whitespace between adjacent tags", () => {
    const out = formatSsoMetadataXml("<a>\n  <b/>\n</a>", "  ", "  ");
    expect(out).toBe("  \n  <a>\n    <b/>\n  </a>");
  });

  it("matches go-xmlfmt v1.1.3 byte-for-byte on a realistic SAML fragment", () => {
    const saml =
      '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://example.com">' +
      '<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">' +
      '<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.com/sso"/>' +
      "</IDPSSODescriptor>" +
      "</EntityDescriptor>";
    // Verified against `xmlfmt.FormatXML(saml, "  ", "  ")` in a Go program
    // using `github.com/go-xmlfmt/xmlfmt@v1.1.3`.
    const expected =
      "  \n" +
      '  <EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://example.com">\n' +
      '    <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n' +
      '      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.com/sso"/>\n' +
      "    </IDPSSODescriptor>\n" +
      "  </EntityDescriptor>";
    expect(formatSsoMetadataXml(saml, "  ", "  ")).toBe(expected);
  });
});

describe("toLegacySsoProviderView coercion", () => {
  it("returns an empty view for non-object inputs", () => {
    expect(toLegacySsoProviderView(null).id).toBe("");
    expect(toLegacySsoProviderView("string").id).toBe("");
  });

  it("preserves arbitrary attribute_mapping data (incl. user keys)", () => {
    const view = toLegacySsoProviderView({
      id: "abc",
      saml: { attribute_mapping: { keys: { a: { default: 3 } } } },
    });
    expect(view.saml?.attribute_mapping).toEqual({ keys: { a: { default: 3 } } });
  });
});
