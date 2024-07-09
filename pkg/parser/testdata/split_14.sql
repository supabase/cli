

CREATE OR REPLACE FUNCTION "blocks".delete_orphaned_blocks()
    RETURNS TRIGGER
AS $$
BEGIN
    LOOP
        -- Note that RETURN QUERY does not return from the function - it works
        -- more like the yield-statement in PHP, in that records from the
        -- DELETE..RETURNING statement are returned, and execution then
        -- resumes from the following statement.

        DELETE FROM "blocks"."block" b
        WHERE b.uuid IN (
            SELECT c.block_uuid
            FROM "blocks"."block_count" c
            WHERE c.ref_count = 0 AND c.user_count = 0
        );

        -- The FOUND flag is set TRUE/FALSE after executing a query - so we
        -- EXIT from the LOOP block when the DELETE..RETURNING statement does
        -- not delete and return any records.

        EXIT WHEN NOT FOUND;
    END LOOP;

    RETURN NULL;
END;
$$
LANGUAGE plpgsql;