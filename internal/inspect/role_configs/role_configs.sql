select
  rolname as role_name,
  array_to_string(rolconfig, ',', '*') as custom_config
from
  pg_roles where rolconfig is not null
