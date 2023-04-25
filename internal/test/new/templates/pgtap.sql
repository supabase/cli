BEGIN;
SELECT plan(1);

-- More examples: https://pgtap.org/documentation.html
SELECT has_schema(
    'public',
    'public schema should exist'
);

SELECT * FROM finish();
ROLLBACK;
