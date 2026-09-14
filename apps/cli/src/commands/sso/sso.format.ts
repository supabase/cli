import { Result } from "effect";

import { renderGlamourTable } from "../../output/glamour-table.ts";
import { SsoInvalidUuidError } from "./sso.errors.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Permissive shape that covers both the typed-client output
 * (`V1GetASsoProviderOutput` / list items) and arbitrary JSON returned by the
 * raw POST/PUT path. `attribute_mapping` is left as `unknown` so we can render
 * provider responses that carry user-defined keys.
 */
export interface SsoProviderView {
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
export function toSsoProviderView(value: unknown): SsoProviderView {
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
 * Validates a positional provider-id argument as a canonical UUID.
 * Failure message uses `%q`-style quoting (JSON.stringify wraps the raw input).
 */
export function validateUuid(input: string): Result.Result<string, SsoInvalidUuidError> {
  if (UUID_PATTERN.test(input)) {
    return Result.succeed(input);
  }
  return Result.fail(
    new SsoInvalidUuidError({
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

export function formatProtocol(saml: SsoProviderView["saml"]): string {
  return saml === undefined ? "unknown" : "SAML 2.0";
}

export function formatDomains(domains: SsoProviderView["domains"]): string {
  if (domains === undefined) return "-";
  const list = domains
    .map((d) => d.domain)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  return list.length === 0 ? "-" : list.join(", ");
}

export function formatEntityId(saml: SsoProviderView["saml"]): string {
  if (saml === undefined) return "-";
  return saml.entity_id !== undefined && saml.entity_id !== "" ? saml.entity_id : "-";
}

export function formatNameIdFormat(saml: SsoProviderView["saml"]): string {
  if (saml === undefined) return "-";
  return saml.name_id_format !== undefined && saml.name_id_format !== ""
    ? saml.name_id_format
    : "-";
}

export function formatMetadataSource(saml: SsoProviderView["saml"]): string {
  if (saml === undefined) return "FILE";
  return saml.metadata_url !== undefined && saml.metadata_url !== "" ? saml.metadata_url : "FILE";
}

// Matches opening, closing, comment, declaration, and self-closing tags;
// non-greedy so it doesn't span across consecutive `<…>` clusters.
const XMLFMT_TAG_RE = /<([/!]?)([^>]+?)(\/?)>/g;
const XMLFMT_INTERTAG_SPACES_RE = />\s+</g;

/**
 * Pretty-prints an XML document by inserting newlines and indentation between
 * tags, matching `go-xmlfmt/xmlfmt@v1.1.3`'s output byte-for-byte (excluding
 * its unused nested-tags-in-comments branch). Text between adjacent
 * open/close tags (e.g. `<b>text</b>`) stays inline; other tags start a new,
 * indented line.
 */
export function formatSsoMetadataXml(xml: string, prefix = "  ", indent = "  "): string {
  // Collapse whitespace between adjacent tags so we control the layout.
  const src = xml.replace(XMLFMT_INTERTAG_SPACES_RE, "><");

  let depth = 0;
  // Tracks whether the previous tag was closing/self-closing; when false, a
  // closing tag stays inline (e.g. `<b>text</b>`).
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
    lastEndElem = false;
    const result = "\n" + prefix + indent.repeat(depth) + match;
    depth++;
    return result;
  });

  return prefix + replaced;
}

// Backticks stripped: Glamour renders `SAML 2.0 \`EntityID\`` as an
// inline-code span (plain text under AsciiStyle), but `renderGlamourTable`
// has no markdown awareness, so we drop them here for byte parity.
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
export function renderListProviders(items: ReadonlyArray<SsoProviderView>): string {
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
 * `## Attribute Mapping` and `## SAML 2.0 Metadata XML` sections.
 *
 * The optional sections are plain markdown, not run through Glamour, so their
 * styling differs from the table above. See each subcommand's `SIDE_EFFECTS.md`.
 */
export function renderSingleProvider(provider: SsoProviderView): string {
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
  // Both rows read provider.created_at — see SIDE_EFFECTS.md.
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

export interface SsoInfoPayload {
  readonly acs_url: string;
  readonly entity_id: string;
  readonly relay_state: string;
}

export function buildInfoPayload(ref: string): SsoInfoPayload {
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
      // Glamour collapses the label's trailing space when computing column
      // widths; our flat renderer would double it against cell padding, so
      // it's dropped here to match the established output.
      ["Single sign-on URL (ACS URL)", payload.acs_url],
      ["Audience URI (SP Entity ID)", payload.entity_id],
      ["Default Relay State", payload.relay_state],
    ],
  );
}
