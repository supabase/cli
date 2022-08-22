

CREATE TABLE "blocks"."child_blocks"
(
    parent_uuid  UUID    NOT NULL,
    column_index INT     NOT NULL,
    child_uuids  UUID [] NOT NULL,
    CONSTRAINT child_blocks_parent_uuid_index_pk PRIMARY KEY (parent_uuid, column_index),
    CONSTRAINT child_blocks_block_uuid_fk FOREIGN KEY (parent_uuid) REFERENCES "blocks"."block" (uuid) ON DELETE CASCADE

    -- TODO add a trigger to sanitize child_uuids when a block record is deleted
);