import { GluegunToolbox } from 'gluegun'

export default {
  name: 'stop',
  run: async ({
    print: {
      colors: { highlight },
      spin,
    },
    system: { run, which },
  }: GluegunToolbox) => {
    const spinner = spin('Stopping local Supabase...')

    const dockerCompose = which('docker-compose')
    if (!dockerCompose) {
      spinner.fail(`Cannot find ${highlight('docker-compose')} executable in PATH.`)
      process.exit(1)
    }

    await run('docker-compose --file .supabase/docker/docker-compose.yml --project-name supabase down')

    spinner.succeed('Stopped local Supabase.')
  },
}
