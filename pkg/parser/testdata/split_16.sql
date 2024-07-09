

CREATE TRIGGER delete_orphans
AFTER UPDATE OR DELETE
    ON "blocks"."placement"
FOR EACH STATEMENT
EXECUTE PROCEDURE "blocks".delete_orphaned_blocks();