

CREATE TABLE "blocks"."user_bucket"
(
    user_uuid   UUID PRIMARY KEY NOT NULL,
    block_uuids UUID []          NOT NULL
);