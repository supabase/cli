BEGIN;
SELECT plan(1);

-- Examples: https://pgtap.org/documentation.html

SELECT * FROM finish();
ROLLBACK;
