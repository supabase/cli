
CREATE TABLE "blocks"."block"
(
    uuid                UUID PRIMARY KEY   NOT NULL,
    settings_type       CHARACTER VARYING  NOT NULL,
    settings            JSONB              NOT NULL,
    title               CHARACTER VARYING,
    view_type           CHARACTER VARYING,
    enabled             BOOL DEFAULT TRUE  NOT NULL,
    visibility_settings JSONB
);