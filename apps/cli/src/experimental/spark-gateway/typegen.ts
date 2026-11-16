// TypeScript types in the shape `supabase gen types typescript` writes, from spark's schema description.
import { type Description, typeInfo } from "./catalog.ts";

const TS: Record<string, string> = {
  bool: "boolean", int2: "number", int4: "number", int8: "number", float4: "number", float8: "number", numeric: "number",
  json: "Json", jsonb: "Json",
};
const key = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : JSON.stringify(s));

export function typescript(d: Description, schemas: string[]): string {
  const tsType = (type: string) => {
    const ti = typeInfo(d, type);
    const base = ti.enum ? `Database[${JSON.stringify(ti.enum.schema)}]["Enums"][${JSON.stringify(ti.enum.name)}]` : (TS[ti.base] ?? (ti.base === "void" ? "undefined" : "string"));
    return ti.array ? `${base}[]` : base;
  };
  const out: string[] = [];
  out.push(`export type Json =\n  | string\n  | number\n  | boolean\n  | null\n  | { [key: string]: Json | undefined }\n  | Json[]\n`);
  out.push(`export type Database = {`);
  for (const schema of schemas) {
    const tables = d.tables.filter((t) => t.schema === schema).sort((a, b) => a.name.localeCompare(b.name));
    const views = d.views.filter((v) => v.schema === schema).sort((a, b) => a.name.localeCompare(b.name));
    const enums = d.enums.filter((e) => e.schema === schema).sort((a, b) => a.name.localeCompare(b.name));
    out.push(`  ${key(schema)}: {`);
    out.push(`    Tables: {${tables.length ? "" : "\n      [_ in never]: never"}`);
    for (const t of tables) {
      const cols = [...t.columns].sort((a, b) => a.name.localeCompare(b.name));
      const row = cols.map((c) => `          ${key(c.name)}: ${tsType(c.type)}${c.not_null ? "" : " | null"}`);
      const ins = cols
        .filter((c) => c.identity !== "a" && !c.generated)
        .map((c) => `          ${key(c.name)}${!c.not_null || c.default !== null || c.identity ? "?" : ""}: ${tsType(c.type)}${c.not_null ? "" : " | null"}`);
      const upd = cols.filter((c) => c.identity !== "a" && !c.generated).map((c) => `          ${key(c.name)}?: ${tsType(c.type)}${c.not_null ? "" : " | null"}`);
      const rels = t.constraints
        .filter((k) => k.type === "f" && k.references && schemas.includes(k.references.schema))
        .map((k) => {
          const target = d.tables.find((x) => x.schema === k.references!.schema && x.name === k.references!.table);
          const one = t.constraints.some((u) => (u.type === "p" || u.type === "u") && u.columns.join() === k.columns.join());
          return [
            `          {`,
            `            foreignKeyName: ${JSON.stringify(k.name)}`,
            `            columns: ${JSON.stringify(k.columns)}`,
            `            isOneToOne: ${one}`,
            `            referencedRelation: ${JSON.stringify(target?.name ?? k.references!.table)}`,
            `            referencedColumns: ${JSON.stringify(k.references!.columns)}`,
            `          },`,
          ].join("\n");
        });
      out.push(`      ${key(t.name)}: {`);
      out.push(`        Row: {\n${row.join("\n")}\n        }`);
      out.push(`        Insert: {\n${ins.join("\n")}\n        }`);
      out.push(`        Update: {\n${upd.join("\n")}\n        }`);
      out.push(`        Relationships: [${rels.length ? `\n${rels.join("\n")}\n        ` : ""}]`);
      out.push(`      }`);
    }
    out.push(`    }`);
    out.push(`    Views: {${views.length ? "" : "\n      [_ in never]: never"}`);
    // The description carries no view columns.
    for (const v of views) out.push(`      ${key(v.name)}: {\n        Row: {\n          [key: string]: Json | undefined\n        }\n        Relationships: []\n      }`);
    out.push(`    }`);
    out.push(`    Functions: {\n      [_ in never]: never\n    }`);
    out.push(`    Enums: {${enums.length ? "" : "\n      [_ in never]: never"}`);
    for (const e of enums) out.push(`      ${key(e.name)}: ${e.labels.map((l) => JSON.stringify(l)).join(" | ")}`);
    out.push(`    }`);
    out.push(`    CompositeTypes: {\n      [_ in never]: never\n    }`);
    out.push(`  }`);
  }
  out.push(`}\n`);
  out.push(HELPERS);
  out.push(`export const Constants = {\n${schemas
    .map((s) => `  ${key(s)}: {\n    Enums: {${d.enums.filter((e) => e.schema === s).map((e) => `\n      ${key(e.name)}: ${JSON.stringify(e.labels)},`).join("")}\n    },\n  },`)
    .join("\n")}\n} as const\n`);
  return out.join("\n");
}

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
