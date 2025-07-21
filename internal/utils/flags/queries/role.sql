do $func$
begin
  if not exists (
    select 1
    from pg_roles
    where rolname = '{{ .User }}'
  )
  then
    create role "{{ .User }}" noinherit login noreplication in role postgres;
  end if;
  execute format(
    $$alter role "{{ .User }}" with password '{{ .Password }}' valid until %L$$,
    now() + interval '5 minutes'
  );
end
$func$ language plpgsql;
