

CREATE VIEW "blocks"."block_count" AS
    SELECT
        b."uuid"                               AS "block_uuid",
        (
            (SELECT COUNT(*)
                FROM "blocks"."placement" p
                WHERE p."block_uuid" = b."uuid")
            +
            (SELECT COALESCE(SUM((SELECT COUNT(*)
                                    FROM unnest(c."child_uuids") cb
                                    WHERE cb = b."uuid")), 0)
                FROM "blocks"."child_blocks" c)
        )                                      AS "ref_count",
        (SELECT COUNT(*)
            FROM "blocks"."user_bucket" k
            WHERE "uuid" = ANY (k."block_uuids")) AS "user_count"
    FROM "blocks"."block" b;