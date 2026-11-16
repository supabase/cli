import type { Description } from "./Description.ts";
import { typeInfo } from "./Catalog.ts";

const TS: Readonly<Record<string, string>> = {
  bool: "boolean",
  int2: "number",
  int4: "number",
  int8: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  json: "Json",
  jsonb: "Json",
};

const key = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(s) ? s : JSON.stringify(s));

/** TypeScript types in the shape `supabase gen types typescript` writes, from Spark's description. */
export const typescript = (description: Description, schemas: ReadonlyArray<string>): string => {
  const tsType = (type: string) => {
    const info = typeInfo(description, type);
    const base =
      info.enum === undefined
        ? (TS[info.base] ?? (info.base === "void" ? "undefined" : "string"))
        : `Database[${JSON.stringify(info.enum.schema)}]["Enums"][${JSON.stringify(info.enum.name)}]`;
    return info.array ? `${base}[]` : base;
  };
  const out: Array<string> = [];
  out.push(
    `export type Json =\n  | string\n  | number\n  | boolean\n  | null\n  | { [key: string]: Json | undefined }\n  | Json[]\n`,
  );
  out.push(`export type Database = {`);
  for (const schema of schemas) {
    const tables = description.tables
      .filter((t) => t.schema === schema)
      .sort((a, b) => a.name.localeCompare(b.name));
    const views = description.views
      .filter((v) => v.schema === schema)
      .sort((a, b) => a.name.localeCompare(b.name));
    const enums = description.enums
      .filter((e) => e.schema === schema)
      .sort((a, b) => a.name.localeCompare(b.name));
    out.push(`  ${key(schema)}: {`);
    out.push(`    Tables: {${tables.length > 0 ? "" : "\n      [_ in never]: never"}`);
    for (const t of tables) {
      const columns = [...t.columns].sort((a, b) => a.name.localeCompare(b.name));
      const writable = columns.filter(
        (c) => c.identity !== "a" && (c.generated === null || c.generated === ""),
      );
      const nullable = (notNull: boolean) => (notNull ? "" : " | null");
      const row = columns.map(
        (c) => `          ${key(c.name)}: ${tsType(c.type)}${nullable(c.not_null)}`,
      );
      const insert = writable.map(
        (c) =>
          `          ${key(c.name)}${!c.not_null || c.default !== null || c.identity !== null ? "?" : ""}: ${tsType(c.type)}${nullable(c.not_null)}`,
      );
      const update = writable.map(
        (c) => `          ${key(c.name)}?: ${tsType(c.type)}${nullable(c.not_null)}`,
      );
      const relationships = t.constraints.flatMap((k) => {
        const references = k.references;
        if (k.type !== "f" || references === null || !schemas.includes(references.schema))
          return [];
        const target = description.tables.find(
          (x) => x.schema === references.schema && x.name === references.table,
        );
        const one = t.constraints.some(
          (u) => (u.type === "p" || u.type === "u") && u.columns.join() === k.columns.join(),
        );
        return [
          [
            `          {`,
            `            foreignKeyName: ${JSON.stringify(k.name)}`,
            `            columns: ${JSON.stringify(k.columns)}`,
            `            isOneToOne: ${String(one)}`,
            `            referencedRelation: ${JSON.stringify(target?.name ?? references.table)}`,
            `            referencedColumns: ${JSON.stringify(references.columns)}`,
            `          },`,
          ].join("\n"),
        ];
      });
      out.push(`      ${key(t.name)}: {`);
      out.push(`        Row: {\n${row.join("\n")}\n        }`);
      out.push(`        Insert: {\n${insert.join("\n")}\n        }`);
      out.push(`        Update: {\n${update.join("\n")}\n        }`);
      out.push(
        `        Relationships: [${relationships.length > 0 ? `\n${relationships.join("\n")}\n        ` : ""}]`,
      );
      out.push(`      }`);
    }
    out.push(`    }`);
    out.push(`    Views: {${views.length > 0 ? "" : "\n      [_ in never]: never"}`);
    // The description carries no view columns.
    for (const v of views)
      out.push(
        `      ${key(v.name)}: {\n        Row: {\n          [key: string]: Json | undefined\n        }\n        Relationships: []\n      }`,
      );
    out.push(`    }`);
    out.push(`    Functions: {\n      [_ in never]: never\n    }`);
    out.push(`    Enums: {${enums.length > 0 ? "" : "\n      [_ in never]: never"}`);
    for (const e of enums)
      out.push(`      ${key(e.name)}: ${e.labels.map((l) => JSON.stringify(l)).join(" | ")}`);
    out.push(`    }`);
    out.push(`    CompositeTypes: {\n      [_ in never]: never\n    }`);
    out.push(`  }`);
  }
  out.push(`}\n`);
  out.push(HELPERS);
  const constants = schemas
    .map(
      (s) =>
        `  ${key(s)}: {\n    Enums: {${description.enums
          .filter((e) => e.schema === s)
          .map((e) => `\n      ${key(e.name)}: ${JSON.stringify(e.labels)},`)
          .join("")}\n    },\n  },`,
    )
    .join("\n");
  out.push(`export const Constants = {\n${constants}\n} as const\n`);
  return out.join("\n");
};

const HELPERS = `type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never
`;
