CREATE OR REPLACE TRIGGER "delete_images" AFTER DELETE ON "storage"."objects" FOR EACH ROW EXECUTE FUNCTION "public"."check_can_upload"();

CREATE OR REPLACE TRIGGER "insert_images" AFTER INSERT ON "storage"."objects" FOR EACH ROW EXECUTE FUNCTION "public"."check_can_upload"();

ALTER TABLE ONLY "storage"."objects"
    ADD CONSTRAINT "objects_owner_fkey" FOREIGN KEY ("owner") REFERENCES "auth"."users"("id");

CREATE POLICY "Anyone can read owner" ON "storage"."objects" FOR SELECT USING ((("bucket_id" = 'public-images'::"text") AND ("owner" IS NULL)));

CREATE POLICY "Authenticated users can delete images" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'public-images'::"text") AND ("auth"."uid"() = "owner")));

CREATE POLICY "Authenticated users can insert images" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'public-images'::"text") AND ("auth"."uid"() = "owner")));

CREATE POLICY "Authenticated users can read images" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'public-images'::"text") AND ("auth"."uid"() = "owner")));

CREATE POLICY "Authenticated users can update images" ON "storage"."objects" FOR UPDATE TO "authenticated" USING (("bucket_id" = 'public-images'::"text")) WITH CHECK (("auth"."uid"() = "owner"));

CREATE POLICY "objects_auth_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING (("owner" = "auth"."uid"()));

