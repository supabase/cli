import { GluegunToolbox } from 'gluegun'

export default {
  name: 'start',
  run: async ({
    filesystem: { exists },
    print: {
      colors: { highlight },
      error,
      spin,
    },
    system: { run, which },
  }: GluegunToolbox) => {
    if (!exists('.supabase')) {
      error(
        `Cannot find ${highlight(
          '.supabase'
        )} in the current directory. Perhaps you meant to run ${highlight('supabase init')} first?`
      )
      process.exit(1)
    }

    const dockerCompose = which('docker-compose')
    if (!dockerCompose) {
      error(`Cannot find ${highlight('docker-compose')} executable in PATH.`)
      process.exit(1)
    }

    const spinner = spin('Starting local Supabase...')

    await run(
      'docker-compose --file .supabase/docker/docker-compose.yml --project-name supabase up --detach'
    ).catch((err: unknown) => {
      if (err instanceof Error) {
        spinner.fail(`Error running docker-compose: ${err.message}`)
        process.exit(1)
      } else {
        spinner.fail('Error running docker-compose.')
        process.exit(1)
      }
    })

    spinner.succeed('Started local Supabase.')
  },
}
