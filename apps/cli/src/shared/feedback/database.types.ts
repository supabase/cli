export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "10.2.0 (e07807d)"
  }
  public: {
    Tables: {
      feedback: {
        Row: {
          date_created: string
          id: number
          metadata: Json | null
          page: string
          vote: Database["public"]["Enums"]["feedback_vote"]
        }
        Insert: {
          date_created?: string
          id?: never
          metadata?: Json | null
          page: string
          vote: Database["public"]["Enums"]["feedback_vote"]
        }
        Update: {
          date_created?: string
          id?: never
          metadata?: Json | null
          page?: string
          vote?: Database["public"]["Enums"]["feedback_vote"]
        }
        Relationships: []
      }
      feedback_comments: {
        Row: {
          comment: string
          created_at: string
          id: number
          metadata: Json | null
          page: string
          title: string | null
          user_id: string | null
          vote: Database["public"]["Enums"]["feedback_vote"] | null
        }
        Insert: {
          comment: string
          created_at?: string
          id?: never
          metadata?: Json | null
          page: string
          title?: string | null
          user_id?: string | null
          vote?: Database["public"]["Enums"]["feedback_vote"] | null
        }
        Update: {
          comment?: string
          created_at?: string
          id?: never
          metadata?: Json | null
          page?: string
          title?: string | null
          user_id?: string | null
          vote?: Database["public"]["Enums"]["feedback_vote"] | null
        }
        Relationships: []
      }
      incident_status_cache: {
        Row: {
          affected_regions: string[] | null
          affects_project_creation: boolean
          id: number
          incident_id: string
          shortlink: string
          updated_at: string
        }
        Insert: {
          affected_regions?: string[] | null
          affects_project_creation?: boolean
          id?: never
          incident_id: string
          shortlink: string
          updated_at?: string
        }
        Update: {
          affected_regions?: string[] | null
          affects_project_creation?: boolean
          id?: never
          incident_id?: string
          shortlink?: string
          updated_at?: string
        }
        Relationships: []
      }
      interfaces_feedback: {
        Row: {
          created_at: string
          delete_token: string
          feedback: string
          id: number
          metadata: Json | null
          project_ref: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          delete_token?: string
          feedback: string
          id?: never
          metadata?: Json | null
          project_ref?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          delete_token?: string
          feedback?: string
          id?: never
          metadata?: Json | null
          project_ref?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      last_changed: {
        Row: {
          checksum: string
          heading: string
          id: number
          last_checked: string
          last_updated: string
          parent_page: string
        }
        Insert: {
          checksum: string
          heading: string
          id?: never
          last_checked?: string
          last_updated?: string
          parent_page: string
        }
        Update: {
          checksum?: string
          heading?: string
          id?: never
          last_checked?: string
          last_updated?: string
          parent_page?: string
        }
        Relationships: []
      }
      launch_weeks: {
        Row: {
          created_at: string
          end_date: string | null
          id: string
          start_date: string | null
        }
        Insert: {
          created_at?: string
          end_date?: string | null
          id: string
          start_date?: string | null
        }
        Update: {
          created_at?: string
          end_date?: string | null
          id?: string
          start_date?: string | null
        }
        Relationships: []
      }
      meetups: {
        Row: {
          city: string | null
          country: string | null
          created_at: string
          display_info: string | null
          id: string
          is_live: boolean
          is_published: boolean
          launch_week: string
          link: string | null
          start_at: string | null
          timezone: string | null
          title: string | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string
          display_info?: string | null
          id?: string
          is_live?: boolean
          is_published?: boolean
          launch_week: string
          link?: string | null
          start_at?: string | null
          timezone?: string | null
          title?: string | null
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string
          display_info?: string | null
          id?: string
          is_live?: boolean
          is_published?: boolean
          launch_week?: string
          link?: string | null
          start_at?: string | null
          timezone?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meetups_launch_week_fkey"
            columns: ["launch_week"]
            isOneToOne: false
            referencedRelation: "launch_weeks"
            referencedColumns: ["id"]
          },
        ]
      }
      page: {
        Row: {
          checksum: string | null
          content: string | null
          fts_tokens: unknown
          id: number
          last_refresh: string | null
          meta: Json | null
          path: string
          source: string | null
          title_tokens: unknown
          type: string | null
          version: string | null
        }
        Insert: {
          checksum?: string | null
          content?: string | null
          fts_tokens?: unknown
          id?: number
          last_refresh?: string | null
          meta?: Json | null
          path: string
          source?: string | null
          title_tokens?: unknown
          type?: string | null
          version?: string | null
        }
        Update: {
          checksum?: string | null
          content?: string | null
          fts_tokens?: unknown
          id?: number
          last_refresh?: string | null
          meta?: Json | null
          path?: string
          source?: string | null
          title_tokens?: unknown
          type?: string | null
          version?: string | null
        }
        Relationships: []
      }
      page_nimbus: {
        Row: {
          checksum: string | null
          content: string | null
          fts_tokens: unknown
          id: number
          last_refresh: string | null
          meta: Json | null
          path: string
          source: string | null
          title_tokens: unknown
          type: string | null
          version: string | null
        }
        Insert: {
          checksum?: string | null
          content?: string | null
          fts_tokens?: unknown
          id?: never
          last_refresh?: string | null
          meta?: Json | null
          path: string
          source?: string | null
          title_tokens?: unknown
          type?: string | null
          version?: string | null
        }
        Update: {
          checksum?: string | null
          content?: string | null
          fts_tokens?: unknown
          id?: never
          last_refresh?: string | null
          meta?: Json | null
          path?: string
          source?: string | null
          title_tokens?: unknown
          type?: string | null
          version?: string | null
        }
        Relationships: []
      }
      page_section: {
        Row: {
          content: string | null
          embedding: string | null
          heading: string | null
          id: number
          page_id: number
          rag_ignore: boolean | null
          slug: string | null
          token_count: number | null
        }
        Insert: {
          content?: string | null
          embedding?: string | null
          heading?: string | null
          id?: number
          page_id: number
          rag_ignore?: boolean | null
          slug?: string | null
          token_count?: number | null
        }
        Update: {
          content?: string | null
          embedding?: string | null
          heading?: string | null
          id?: number
          page_id?: number
          rag_ignore?: boolean | null
          slug?: string | null
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "page_section_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "page"
            referencedColumns: ["id"]
          },
        ]
      }
      page_section_nimbus: {
        Row: {
          content: string | null
          embedding: string | null
          heading: string | null
          id: number
          page_id: number
          rag_ignore: boolean | null
          slug: string | null
          token_count: number | null
        }
        Insert: {
          content?: string | null
          embedding?: string | null
          heading?: string | null
          id?: never
          page_id: number
          rag_ignore?: boolean | null
          slug?: string | null
          token_count?: number | null
        }
        Update: {
          content?: string | null
          embedding?: string | null
          heading?: string | null
          id?: never
          page_id?: number
          rag_ignore?: boolean | null
          slug?: string | null
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "page_section_nimbus_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "page_nimbus"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          company: string | null
          created_at: string
          email: string | null
          game_won_at: string | null
          id: string
          launch_week: string
          location: string | null
          metadata: Json | null
          name: string | null
          referred_by: string | null
          role: string | null
          shared_on_linkedin: string | null
          shared_on_twitter: string | null
          ticket_number: number
          user_id: string
          username: string | null
        }
        Insert: {
          company?: string | null
          created_at?: string
          email?: string | null
          game_won_at?: string | null
          id?: string
          launch_week: string
          location?: string | null
          metadata?: Json | null
          name?: string | null
          referred_by?: string | null
          role?: string | null
          shared_on_linkedin?: string | null
          shared_on_twitter?: string | null
          ticket_number?: number
          user_id: string
          username?: string | null
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string | null
          game_won_at?: string | null
          id?: string
          launch_week?: string
          location?: string | null
          metadata?: Json | null
          name?: string | null
          referred_by?: string | null
          role?: string | null
          shared_on_linkedin?: string | null
          shared_on_twitter?: string | null
          ticket_number?: number
          user_id?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tickets_launch_week_fkey"
            columns: ["launch_week"]
            isOneToOne: false
            referencedRelation: "launch_weeks"
            referencedColumns: ["id"]
          },
        ]
      }
      troubleshooting_entries: {
        Row: {
          api: Json | null
          checksum: string
          date_created: string
          date_updated: string
          errors: Json[] | null
          github_id: string
          github_url: string
          id: string
          keywords: string[] | null
          title: string
          topics: string[]
        }
        Insert: {
          api?: Json | null
          checksum: string
          date_created?: string
          date_updated?: string
          errors?: Json[] | null
          github_id: string
          github_url: string
          id?: string
          keywords?: string[] | null
          title: string
          topics: string[]
        }
        Update: {
          api?: Json | null
          checksum?: string
          date_created?: string
          date_updated?: string
          errors?: Json[] | null
          github_id?: string
          github_url?: string
          id?: string
          keywords?: string[] | null
          title?: string
          topics?: string[]
        }
        Relationships: []
      }
      validation_history: {
        Row: {
          created_at: string
          id: number
          tag: string
        }
        Insert: {
          created_at?: string
          id?: never
          tag: string
        }
        Update: {
          created_at?: string
          id?: never
          tag?: string
        }
        Relationships: []
      }
    }
    Views: {
      tickets_view: {
        Row: {
          company: string | null
          created_at: string | null
          id: string | null
          launch_week: string | null
          location: string | null
          metadata: Json | null
          name: string | null
          platinum: boolean | null
          referrals: number | null
          role: string | null
          secret: boolean | null
          shared_on_linkedin: string | null
          shared_on_twitter: string | null
          ticket_number: number | null
          username: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tickets_launch_week_fkey"
            columns: ["launch_week"]
            isOneToOne: false
            referencedRelation: "launch_weeks"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      cleanup_last_changed_pages: { Args: never; Returns: number }
      docs_search_embeddings: {
        Args: { embedding: string; match_threshold: number }
        Returns: {
          description: string
          headings: string[]
          id: number
          path: string
          slugs: string[]
          subtitle: string
          title: string
          type: string
        }[]
      }
      docs_search_embeddings_nimbus: {
        Args: { embedding: string; match_threshold: number }
        Returns: {
          description: string
          headings: string[]
          id: number
          path: string
          slugs: string[]
          subtitle: string
          title: string
          type: string
        }[]
      }
      docs_search_fts: {
        Args: { query: string }
        Returns: {
          description: string
          id: number
          path: string
          subtitle: string
          title: string
          type: string
        }[]
      }
      docs_search_fts_nimbus: {
        Args: { query: string }
        Returns: {
          description: string
          id: number
          path: string
          subtitle: string
          title: string
          type: string
        }[]
      }
      get_full_content_url: {
        Args: { path: string; slug: string; type: string }
        Returns: string
      }
      get_last_revalidation_for_tags: {
        Args: { tags: string[] }
        Returns: {
          created_at: string
          tag: string
        }[]
      }
      ipv6_active_status: {
        Args: { project_ref: string }
        Returns: {
          pgbouncer_active: boolean
          vercel_active: boolean
        }[]
      }
      json_matches_schema: {
        Args: { instance: Json; schema: Json }
        Returns: boolean
      }
      jsonb_matches_schema: {
        Args: { instance: Json; schema: Json }
        Returns: boolean
      }
      match_embedding: {
        Args: {
          embedding: string
          match_threshold?: number
          max_results?: number
        }
        Returns: {
          content: string | null
          embedding: string | null
          heading: string | null
          id: number
          page_id: number
          rag_ignore: boolean | null
          slug: string | null
          token_count: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "page_section"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      match_embedding_nimbus: {
        Args: {
          embedding: string
          match_threshold?: number
          max_results?: number
        }
        Returns: {
          content: string | null
          embedding: string | null
          heading: string | null
          id: number
          page_id: number
          rag_ignore: boolean | null
          slug: string | null
          token_count: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "page_section_nimbus"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      match_page_sections_v2: {
        Args: {
          embedding: string
          match_threshold: number
          min_content_length: number
        }
        Returns: {
          content: string | null
          embedding: string | null
          heading: string | null
          id: number
          page_id: number
          rag_ignore: boolean | null
          slug: string | null
          token_count: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "page_section"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      match_page_sections_v2_nimbus: {
        Args: {
          embedding: string
          match_threshold: number
          min_content_length: number
        }
        Returns: {
          content: string | null
          embedding: string | null
          heading: string | null
          id: number
          page_id: number
          rag_ignore: boolean | null
          slug: string | null
          token_count: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "page_section_nimbus"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      search_content: {
        Args: {
          embedding: string
          include_full_content?: boolean
          match_threshold?: number
          max_result?: number
        }
        Returns: {
          content: string
          href: string
          id: number
          metadata: Json
          page_title: string
          subsections: Json[]
          type: string
        }[]
      }
      search_content_hybrid: {
        Args: {
          full_text_weight?: number
          include_full_content?: boolean
          match_threshold?: number
          max_result?: number
          query_embedding: string
          query_text: string
          rrf_k?: number
          semantic_weight?: number
        }
        Returns: {
          content: string
          href: string
          id: number
          metadata: Json
          page_title: string
          subsections: Json[]
          type: string
        }[]
      }
      search_content_hybrid_nimbus: {
        Args: {
          full_text_weight?: number
          include_full_content?: boolean
          match_threshold?: number
          max_result?: number
          query_embedding: string
          query_text: string
          rrf_k?: number
          semantic_weight?: number
        }
        Returns: {
          content: string
          href: string
          id: number
          metadata: Json
          page_title: string
          subsections: Json[]
          type: string
        }[]
      }
      search_content_nimbus: {
        Args: {
          embedding: string
          include_full_content?: boolean
          match_threshold?: number
          max_result?: number
        }
        Returns: {
          content: string
          href: string
          id: number
          metadata: Json
          page_title: string
          subsections: Json[]
          type: string
        }[]
      }
      submit_interfaces_feedback: {
        Args: {
          feedback: string
          metadata?: Json
          project_ref?: string
          user_agent?: string
          user_id?: string
        }
        Returns: string
      }
      update_last_changed_checksum: {
        Args: {
          check_time: string
          git_update_time: string
          new_checksum: string
          new_heading: string
          new_parent_page: string
        }
        Returns: string
      }
      validate_troubleshooting_errors: {
        Args: { errors: Json[] }
        Returns: boolean
      }
    }
    Enums: {
      feedback_vote: "yes" | "no"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      feedback_vote: ["yes", "no"],
    },
  },
} as const
