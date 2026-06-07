

CREATE UNIQUE INDEX "user_bucket_user_uuid_uindex"
    ON "blocks"."user_bucket" (user_uuid);