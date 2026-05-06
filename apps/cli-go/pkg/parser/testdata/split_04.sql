

CREATE TABLE "blocks"."placement"
(
    location_name   CHARACTER VARYING   NOT NULL,
    index           INT                 NOT NULL,
    block_uuid      UUID                NOT NULL,
    scope_path      CHARACTER VARYING   NOT NULL,
    inherited       BOOL DEFAULT FALSE  NOT NULL,
    excluded_scopes CHARACTER VARYING [],

    -- NOTE: Because we UPDATE the primary (location_name, index) key on the placement-table,
    -- the constraint behavior on the primary key is set to DEFERRABLE and INITIALLY IMMEDIATE.
    --
    -- For more inforation, refer to this bug-report:
    --
    -- https://www.postgresql.org/message-id/flat/20170322123053.1421.55154%40wrigleys.postgresql.org

    CONSTRAINT placement_location_name_index_pk PRIMARY KEY (location_name, index) DEFERRABLE INITIALLY IMMEDIATE,
    CONSTRAINT placement_block_uuid_fk FOREIGN KEY (block_uuid) REFERENCES "blocks"."block" (uuid) ON DELETE CASCADE
);