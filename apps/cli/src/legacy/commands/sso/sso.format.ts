import { Result } from "effect";

import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";
import { LegacySsoInvalidUuidError } from "./sso.errors.ts";

// UUIDs are matched case-insensitively so callers passing
// `B5AE62F9-…` (mixed- or upper-case) succeed.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Permissive shape that covers both the typed-client output
 * (`V1GetASsoProviderOutput` / list items) and arbitrary JSON returned by the
 * raw POST/PUT path. `attribute_mapping` is left as `unknown` so we can render
 * provider responses that carry user-defined keys.
 */
export interface LegacySsoProviderView {
  readonly id: string;
  readonly saml?: {
    readonly entity_id?: string;
    readonly metadata_url?: string;
    readonly metadata_xml?: string;
    readonly name_id_format?: string;
    readonly attribute_mapping?: unknown;
  };
  readonly domains?: ReadonlyArray<{
    readonly domain?: string;
    readonly created_at?: string;
    readonly updated_at?: string;
  }>;
  readonly created_at?: string;
  readonly updated_at?: string;
}

/**
 * Defensive extraction for the raw-HTTP add/update path. The response is
 * untyped (we bypass the generated schema to preserve `attribute_mapping.keys.<x>.default`),
 * so the formatter coerces an arbitrary object into the provider view shape
 * without throwing on missing fields.
 */
export function toLegacySsoProviderView(value: unknown): LegacySsoProviderView {
  if (typeof value !== "object" || value === null) {
    return { id: "" };
  }
  const root = value as Record<string, unknown>;
  const samlRaw = root["saml"];
  const saml =
    samlRaw !== undefined && typeof samlRaw === "object" && samlRaw !== null
      ? (samlRaw as Record<string, unknown>)
      : undefined;

  const domainsRaw = root["domains"];
  const domains = Array.isArray(domainsRaw)
    ? domainsRaw
        .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
        .map((d) => ({
          domain: typeof d["domain"] === "string" ? d["domain"] : undefined,
          created_at: typeof d["created_at"] === "string" ? d["created_at"] : undefined,
          updated_at: typeof d["updated_at"] === "string" ? d["updated_at"] : undefined,
        }))
    : undefined;

  return {
    id: typeof root["id"] === "string" ? root["id"] : "",
    saml:
      saml === undefined
        ? undefined
        : {
            entity_id: typeof saml["entity_id"] === "string" ? saml["entity_id"] : undefined,
            metadata_url:
              typeof saml["metadata_url"] === "string" ? saml["metadata_url"] : undefined,
            metadata_xml:
              typeof saml["metadata_xml"] === "string" ? saml["metadata_xml"] : undefined,
            name_id_format:
              typeof saml["name_id_format"] === "string" ? saml["name_id_format"] : undefined,
            attribute_mapping: saml["attribute_mapping"],
          },
    domains,
    created_at: typeof root["created_at"] === "string" ? root["created_at"] : undefined,
    updated_at: typeof root["updated_at"] === "string" ? root["updated_at"] : undefined,
  };
}

/**
 * Projects an arbitrary provider response onto the fields represented by the
 * legacy Go provider struct. The Management API's generated response schema
 * is intentionally strict, but older projects can return null values inside
 * `attribute_mapping.keys.*.default`; this projection keeps those values for
 * the Go output encoders while dropping fields (such as nested IDs) that Go
 * would ignore.
 */
export function normalizeLegacySsoProviderPayload(value: unknown): Record<string, unknown> {
  const view = toLegacySsoProviderView(value);
  const result: Record<string, unknown> = { id: view.id };

  if (view.saml !== undefined) {
    const saml: Record<string, unknown> = {};
    if (view.saml.entity_id !== undefined) saml["entity_id"] = view.saml.entity_id;
    if (view.saml.metadata_url !== undefined) saml["metadata_url"] = view.saml.metadata_url;
    if (view.saml.metadata_xml !== undefined) saml["metadata_xml"] = view.saml.metadata_xml;
    if (view.saml.attribute_mapping !== undefined) {
      saml["attribute_mapping"] = view.saml.attribute_mapping;
    }
    if (view.saml.name_id_format !== undefined) {
      saml["name_id_format"] = view.saml.name_id_format;
    }
    result["saml"] = saml;
  }

  if (view.domains !== undefined) {
    result["domains"] = view.domains.map((domain) => ({
      ...(domain.domain === undefined ? {} : { domain: domain.domain }),
      ...(domain.created_at === undefined ? {} : { created_at: domain.created_at }),
      ...(domain.updated_at === undefined ? {} : { updated_at: domain.updated_at }),
    }));
  }
  if (view.created_at !== undefined) result["created_at"] = view.created_at;
  if (view.updated_at !== undefined) result["updated_at"] = view.updated_at;
  return result;
}

/** Extracts the list payload while retaining unknown nested mapping values. */
export function readLegacySsoProviderItems(value: unknown): ReadonlyArray<unknown> | undefined {
  if (typeof value !== "object" || value === null || !("items" in value)) return undefined;
  const items = value.items;
  return Array.isArray(items) ? items : undefined;
}

/**
 * Validates a positional provider-id argument as a canonical UUID.
 * Failure message uses `%q`-style quoting (JSON.stringify wraps the raw input).
 */
export function validateUuid(input: string): Result.Result<string, LegacySsoInvalidUuidError> {
  if (UUID_PATTERN.test(input)) {
    return Result.succeed(input);
  }
  return Result.fail(
    new LegacySsoInvalidUuidError({
      providerId: input,
      message: `identity provider ID ${JSON.stringify(input)} is not a UUID`,
    }),
  );
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * RFC3339 → `YYYY-MM-DD HH:MM:SS` (UTC, no timezone label).
 */
export function formatSsoTimestamp(input?: string): string {
  if (input === undefined || input === null) return "";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  );
}

export function formatProtocol(saml: LegacySsoProviderView["saml"]): string {
  return saml === undefined ? "unknown" : "SAML 2.0";
}

export function formatDomains(domains: LegacySsoProviderView["domains"]): string {
  if (domains === undefined) return "-";
  const list = domains
    .map((d) => d.domain)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  return list.length === 0 ? "-" : list.join(", ");
}

export function formatEntityId(saml: LegacySsoProviderView["saml"]): string {
  if (saml === undefined) return "-";
  return saml.entity_id !== undefined && saml.entity_id !== "" ? saml.entity_id : "-";
}

export function formatNameIdFormat(saml: LegacySsoProviderView["saml"]): string {
  if (saml === undefined) return "-";
  return saml.name_id_format !== undefined && saml.name_id_format !== ""
    ? saml.name_id_format
    : "-";
}

export function formatMetadataSource(saml: LegacySsoProviderView["saml"]): string {
  if (saml === undefined) return "FILE";
  return saml.metadata_url !== undefined && saml.metadata_url !== "" ? saml.metadata_url : "FILE";
}

// Tag matcher mirroring go-xmlfmt's `reg`: captures opening, closing, comment,
// declaration, and self-closing tags. Non-greedy inner body so we don't span
// across consecutive `<…>` clusters.
const XMLFMT_TAG_RE = /<([/!]?)([^>]+?)(\/?)>/g;
const XMLFMT_INTERTAG_SPACES_RE = />\s+</g;

/**
 * Pretty-prints an XML document by inserting newlines and indentation between
 * tags. Behaviour-compatible port of `github.com/go-xmlfmt/xmlfmt@v1.1.3`
 * `FormatXML(xml, prefix, indent)` (without the nested-tags-in-comments
 * branch, which the SSO render call site never enables). Each tag boundary
 * becomes `\n + prefix + indent.repeat(depth) + <tag>`; opening tags increment
 * depth after emission, closing tags decrement before. Text content between
 * adjacent open/close tags (e.g. `<b>text</b>`) is preserved inline so the
 * close tag rides the same line.
 */
export function formatSsoMetadataXml(xml: string, prefix = "  ", indent = "  "): string {
  // Collapse whitespace between adjacent tags so we control the layout.
  const src = xml.replace(XMLFMT_INTERTAG_SPACES_RE, "><");

  let depth = 0;
  // Tracks whether the previous tag was a closing or self-closing tag.
  // Used to decide whether a closing tag rides the same line as adjacent
  // content (lastEndElem=false → inline close, e.g. `<b>text</b>`).
  let lastEndElem = true;

  const replaced = src.replace(XMLFMT_TAG_RE, (match) => {
    if (match.startsWith("<?xml")) {
      return "\n" + prefix + indent.repeat(depth) + match;
    }
    if (match.endsWith("/>")) {
      lastEndElem = true;
      return "\n" + prefix + indent.repeat(depth) + match;
    }
    if (match.startsWith("<!")) {
      return "\n" + prefix + indent.repeat(depth) + match;
    }
    if (match.startsWith("</")) {
      depth--;
      if (lastEndElem) {
        return "\n" + prefix + indent.repeat(depth) + match;
      }
      lastEndElem = true;
      return match;
    }
    // Opening tag: emit at the current depth, then descend for children.
    lastEndElem = false;
    const result = "\n" + prefix + indent.repeat(depth) + match;
    depth++;
    return result;
  });

  return prefix + replaced;
}

// The markdown header is `SAML 2.0 \`EntityID\``; Glamour renders the
// backticks as an inline-code span which is stripped to plain text under
// AsciiStyle. `renderGlamourTable` is a flat ASCII renderer with no markdown
// awareness, so we drop the backticks here at the source for byte parity
// with the established rendered output.
const LIST_HEADERS = [
  "TYPE",
  "IDENTITY PROVIDER ID",
  "DOMAINS",
  "SAML 2.0 EntityID",
  "CREATED AT (UTC)",
  "UPDATED AT (UTC)",
] as const;

/**
 * Renders the list table.
 */
export function renderListProviders(items: ReadonlyArray<LegacySsoProviderView>): string {
  const rows = items.map(
    (item) =>
      [
        formatProtocol(item.saml),
        item.id,
        formatDomains(item.domains),
        formatEntityId(item.saml),
        formatSsoTimestamp(item.created_at),
        formatSsoTimestamp(item.updated_at),
      ] as const,
  );
  return renderGlamourTable(LIST_HEADERS, rows);
}

/**
 * Renders the single-provider view: property/value table plus optional
 * `## Attribute Mapping` (JSON-indented) and `## SAML 2.0 Metadata XML`
 * sections.
 *
 * The optional sections are emitted as plain markdown (heading + fenced code
 * block); we don't run them through Glamour, so visual styling differs from
 * the table above. Tests assert on substring presence (`toContain`) rather
 * than full byte equality. Documented in each subcommand's `SIDE_EFFECTS.md`.
 */
export function renderSingleProvider(provider: LegacySsoProviderView): string {
  const rows: Array<readonly [string, string]> = [
    ["IDENTITY PROVIDER ID", provider.id],
    ["TYPE", formatProtocol(provider.saml)],
    ["DOMAINS", formatDomains(provider.domains)],
  ];
  if (provider.saml !== undefined) {
    rows.push(["SAML 2.0 METADATA", formatMetadataSource(provider.saml)]);
    // Backticks stripped — see LIST_HEADERS comment above.
    rows.push(["SAML 2.0 EntityID", formatEntityId(provider.saml)]);
    rows.push(["NAMEID FORMAT", formatNameIdFormat(provider.saml)]);
  }
  rows.push(["CREATED AT (UTC)", formatSsoTimestamp(provider.created_at)]);
  // Both CREATED AT and UPDATED AT rows use provider.created_at — an
  // established output contract documented in SIDE_EFFECTS.md.
  rows.push(["UPDATED AT (UTC)", formatSsoTimestamp(provider.created_at)]);

  const table = renderGlamourTable(["PROPERTY", "VALUE"], rows);

  const sections: string[] = [table];

  if (
    provider.saml?.attribute_mapping !== undefined &&
    hasAtLeastOneKey(provider.saml.attribute_mapping)
  ) {
    sections.push("## Attribute Mapping\n");
    sections.push("```json\n");
    sections.push(JSON.stringify(provider.saml.attribute_mapping, null, 2) + "\n");
    sections.push("```\n");
  }

  if (provider.saml?.metadata_xml !== undefined && provider.saml.metadata_xml.length > 0) {
    sections.push("## SAML 2.0 Metadata XML\n");
    sections.push("```xml\n");
    sections.push(formatSsoMetadataXml(provider.saml.metadata_xml, "  ", "  ") + "\n");
    sections.push("```\n");
  }

  return sections.join("");
}

function hasAtLeastOneKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = (value as { keys?: unknown }).keys;
  if (typeof keys !== "object" || keys === null) return false;
  return Object.keys(keys).length > 0;
}

export interface LegacySsoInfoPayload {
  readonly acs_url: string;
  readonly entity_id: string;
  readonly relay_state: string;
}

export function buildInfoPayload(ref: string): LegacySsoInfoPayload {
  return {
    acs_url: `https://${ref}.supabase.co/auth/v1/sso/saml/acs`,
    entity_id: `https://${ref}.supabase.co/auth/v1/sso/saml/metadata`,
    relay_state: `https://${ref}.supabase.co`,
  };
}

export function renderInfoMarkdown(ref: string): string {
  const payload = buildInfoPayload(ref);
  return renderGlamourTable(
    ["PROPERTY", "VALUE"],
    [
      // The markdown label is "Single sign-on URL (ACS URL) " (trailing
      // space), but Glamour collapses it when computing column widths so the
      // rendered output has a single space between the label and the column
      // separator. Our flat ASCII renderer would preserve the trailing space
      // and double it up against the cell padding — so we drop it here to
      // match the established rendered output.
      ["Single sign-on URL (ACS URL)", payload.acs_url],
      ["Audience URI (SP Entity ID)", payload.entity_id],
      ["Default Relay State", payload.relay_state],
    ],
  );
}
