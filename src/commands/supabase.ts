import { GluegunToolbox } from 'gluegun'

export default {
  name: 'supabase',
  run: async ({
    meta: { version },
    parameters: { options },
    print: {
      error,
      info,
      fancy,
      colors: { bold, green, muted, highlight },
    },
  }: GluegunToolbox) => {
    const printHelp = () =>
      fancy(`${muted(`Supabase CLI ${version()}`)}

  ${bold(`${green('ϟ')} supabase`)} [options] [<command>]

  Commands:

    init                  Initialize project
    start                 Start local Supabase
    stop                  Stop local Supabase
    eject                 Create a ${highlight(
      'docker'
    )} directory with the Docker setup for Supabase.
                          See ${highlight(
                            'https://supabase.io/docs/guides/self-hosting'
                          )} for details.

  Options:

    -h, --help            Show usage information
    -v, --version         Show version number
`)

    for (const opt in options) {
      if (opt === 'h' || opt === 'help') {
        printHelp()
        return
      }

      if (opt === 'v' || opt === 'version') {
        info(version())
        return
      }

      // unrecognized opt
      printHelp()
      error(`Unknown or unexpected option: ${opt}.`)
      process.exit(1)
    }

    // options.length === 0
    printHelp()
  },
}
