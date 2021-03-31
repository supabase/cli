import { GluegunToolbox } from 'gluegun'
import ignore from 'ignore'

export default {
  name: 'eject',
  run: async ({
    filesystem: { exists },
    template: { generate },
    print: {
      colors: { highlight },
      error,
      spin,
    },
    prompt: { ask },
  }: GluegunToolbox) => {
    if (exists('docker')) {
      error(`${highlight('docker')} exists in the current directory. Remove it to eject.`)
      process.exit(1)
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

    const spinner = spin('Ejecting...')

    // Write templates
    await Promise.all(
      [
        'kong/Dockerfile',
        'kong/kong.yml',
        'postgres/00-initial-schema.sql',
        'postgres/Dockerfile',
        'postgres/auth-schema.sql',
        'docker-compose.yml',
      ].map((f) =>
        generate({
          template: `init/emulator/${f}`,
          target: `docker/${f}`,
          props: {
            kongPort,
            dbPort,
            apiKey,
          },
        })
      )
    )

    spinner.succeed('Supabase Docker ejected.')
  },
}
