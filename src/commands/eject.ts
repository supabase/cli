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
      fancy,
      spin,
    },
    prompt: { ask },
  }: GluegunToolbox) => {
    if (exists('docker')) {
      error(`${highlight('docker')} exists in the current directory. Remove it to eject.`)
      process.exit(1)
    }

    const { kongPort, dbPort, mailPort } = await ask([
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
      {
        type: 'input',
        name: 'mailPort',
        message: 'Port for email testing interface:',
        initial: '9000',
      },
    ])

    const anonApiKey =
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTYwMzk2ODgzNCwiZXhwIjoyNTUwNjUzNjM0LCJyb2xlIjoiYW5vbiJ9.36fUebxgx1mcBo4s19v0SzqmzunP--hm_hep0uLX0ew'
    const serviceRoleApiKey =
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTYwMzk2ODgzNCwiZXhwIjoyNTUwNjUzNjM0LCJyb2xlIjoic2VydmljZV9yb2xlIn0.necIJaiP7X2T2QjGeV-FhpkizcNTX8HjDDBAxpgQTEI'

    const spinner = spin('Ejecting...')

    // Write templates
    await Promise.all(
      [
        'kong/Dockerfile',
        'kong/kong.yml',
        'postgres/00-initial-schema.sql',
        'postgres/Dockerfile',
        'postgres/auth-schema.sql',
        'postgres/storage-schema.sql',
        'docker-compose.yml',
      ].map((f) =>
        generate({
          template: `init/docker/${f}`,
          target: `docker/${f}`,
          props: {
            kongPort,
            dbPort,
            mailPort,
            anonApiKey,
            serviceRoleApiKey,
          },
        })
      )
    ).catch(() => {
      spinner.fail('Error writing Docker setup files.')
      process.exit(1)
    })

    spinner.succeed('Supabase Docker ejected.')
    fancy(`Supabase URL: ${highlight(`http://localhost:${kongPort}`)}
Supabase Key (anon, public): ${highlight(anonApiKey)}
Supabase Key (service_role, private): ${highlight(serviceRoleApiKey)}
Database URL: ${highlight(`postgres://postgres:postgres@localhost:${dbPort}/postgres`)}
Email testing interface URL: ${highlight(`http://localhost:${mailPort}`)}
`)
  },
}
