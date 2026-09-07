
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE SCHEMA IF NOT EXISTS "storage";

ALTER SCHEMA "storage" OWNER TO "supabase_admin";

CREATE OR REPLACE FUNCTION "storage"."can_insert_object"("bucketid" "text", "name" "text", "owner" "uuid", "metadata" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  INSERT INTO "storage"."objects" ("bucket_id", "name", "owner", "metadata") VALUES (bucketid, name, owner, metadata);
  -- hack to rollback the successful insert
  RAISE sqlstate 'PT200' using
  message = 'ROLLBACK',
  detail = 'rollback successful insert';
END
$$;

ALTER FUNCTION "storage"."can_insert_object"("bucketid" "text", "name" "text", "owner" "uuid", "metadata" "jsonb") OWNER TO "supabase_storage_admin";

CREATE TABLE IF NOT EXISTS "storage"."objects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bucket_id" "text",
    "name" "text",
    "owner" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "last_accessed_at" timestamp with time zone DEFAULT "now"(),
    "metadata" "jsonb",
    "path_tokens" "text"[] GENERATED ALWAYS AS ("string_to_array"("name", '/'::"text")) STORED,
    "version" "text",
    "owner_id" "text"
);

ALTER TABLE "storage"."objects" OWNER TO "supabase_storage_admin";

COMMENT ON COLUMN "storage"."objects"."owner" IS 'Field is deprecated, use owner_id instead';

ALTER TABLE ONLY "storage"."buckets"
    ADD CONSTRAINT "buckets_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "storage"."migrations"
    ADD CONSTRAINT "migrations_name_key" UNIQUE ("name");

ALTER TABLE ONLY "storage"."migrations"
    ADD CONSTRAINT "migrations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "storage"."objects"
    ADD CONSTRAINT "objects_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX "bname" ON "storage"."buckets" USING "btree" ("name");

CREATE UNIQUE INDEX "bucketid_objname" ON "storage"."objects" USING "btree" ("bucket_id", "name");

CREATE INDEX "name_prefix_search" ON "storage"."objects" USING "btree" ("name" "text_pattern_ops");

CREATE OR REPLACE TRIGGER "delete_images" AFTER DELETE ON "storage"."objects" FOR EACH ROW EXECUTE FUNCTION "public"."check_can_upload"();

CREATE OR REPLACE TRIGGER "insert_images" AFTER INSERT ON "storage"."objects" FOR EACH ROW EXECUTE FUNCTION "public"."check_can_upload"();

CREATE OR REPLACE TRIGGER "update_objects_updated_at" BEFORE UPDATE ON "storage"."objects" FOR EACH ROW EXECUTE FUNCTION "storage"."update_updated_at_column"();

ALTER TABLE ONLY "storage"."objects"
    ADD CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY ("bucket_id") REFERENCES "storage"."buckets"("id");

ALTER TABLE ONLY "storage"."objects"
    ADD CONSTRAINT "objects_owner_fkey" FOREIGN KEY ("owner") REFERENCES "auth"."users"("id");

CREATE POLICY "Anyone can read owner" ON "storage"."objects" FOR SELECT USING ((("bucket_id" = 'public-images'::"text") AND ("owner" IS NULL)));

CREATE POLICY "Authenticated users can delete images" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'public-images'::"text") AND ("auth"."uid"() = "owner")));

CREATE POLICY "Authenticated users can insert images" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'public-images'::"text") AND ("auth"."uid"() = "owner")));

CREATE POLICY "Authenticated users can read images" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'public-images'::"text") AND ("auth"."uid"() = "owner")));

CREATE POLICY "Authenticated users can update images" ON "storage"."objects" FOR UPDATE TO "authenticated" USING (("bucket_id" = 'public-images'::"text")) WITH CHECK (("auth"."uid"() = "owner"));

ALTER TABLE "storage"."buckets" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "storage"."migrations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "storage"."objects" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "objects_auth_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING (("owner" = "auth"."uid"()));

GRANT ALL ON SCHEMA "storage" TO "postgres";
GRANT USAGE ON SCHEMA "storage" TO "anon";
GRANT USAGE ON SCHEMA "storage" TO "authenticated";
GRANT USAGE ON SCHEMA "storage" TO "service_role";
GRANT ALL ON SCHEMA "storage" TO "supabase_storage_admin";
GRANT ALL ON SCHEMA "storage" TO "dashboard_user";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "storage" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "storage" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "storage" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "storage" GRANT ALL ON SEQUENCES  TO "service_role";

RESET ALL;
