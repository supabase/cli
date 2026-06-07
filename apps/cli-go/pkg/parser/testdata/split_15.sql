

CREATE TRIGGER delete_orphans
AFTER UPDATE OR DELETE
    ON "blocks"."user_bucket"
FOR EACH STATEMENT
EXECUTE PROCEDURE "blocks".delete_orphaned_blocks();