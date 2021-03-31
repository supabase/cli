import { GluegunToolbox } from 'gluegun'
import ignore from 'ignore'

export default {
  name: 'init',
  run: async ({
    filesystem: { append, read, exists },
    template: { generate },
    print: {
      colors: { highlight },
      error,
      fancy,
      spin,
    },
    prompt: { ask },
  }: GluegunToolbox) => {
    if (exists('.supabase')) {
      error(`Project already initialized. Remove ${highlight('.supabase')} to reinitialize.`)
      process.exit(1)
    }

    // Add .supabase to .gitignore
    const gitignore = read('.gitignore')
    if (gitignore) {
      const ig = ignore().add(gitignore)
      if (!ig.ignores('.supabase')) {
        append('.gitignore', '\n# Supabase\n.supabase\n')
      }
    }

    const { kongPort, dbPort } = await ask([
      {
        type: 'input',
        name: 'kongPort',
        message: 'Port for Supabase URL:',
        initial: '8000',
      },
      {
        type: 'input',
        name: 'dbPort',
        message: 'Port for PostgreSQL database:',
        initial: '5432',
      },
    ])

    const apiKey =
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTYwMzk2ODgzNCwiZXhwIjoyNTUwNjUzNjM0LCJhdWQiOiIiLCJzdWIiOiIiLCJSb2xlIjoicG9zdGdyZXMifQ.magCcozTMKNrl76Tj2dsM7XTl_YH0v0ilajzAvIlw3U'

    const spinner = spin('Initializing project...')

    // Write templates
    await Promise.all(
      [
        'docker/kong/Dockerfile',
        'docker/kong/kong.yml',
        'docker/postgres/00-initial-schema.sql',
        'docker/postgres/Dockerfile',
        'docker/postgres/auth-schema.sql',
        'docker/docker-compose.yml',
        'README.md',
      ].map((f) =>
        generate({
          template: `init/${f}`,
          target: `.supabase/${f}`,
          props: {
            kongPort,
            dbPort,
            apiKey,
          },
        })
      )
    )

    spinner.succeed('Project initialized.')
    fancy(`Supabase URL: ${highlight(`http://localhost:${kongPort}`)}
Supabase Key: ${highlight(apiKey)}
Database URL: ${highlight(`postgres://postgres:postgres@localhost:${dbPort}/postgres`)}

Run ${highlight('supabase start')} to start local Supabase.
`)
  },
}
