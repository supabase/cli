

CREATE INDEX "child_blocks_parent_uuid_index"
    ON "blocks"."child_blocks" (parent_uuid);