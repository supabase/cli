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
      colors: { bold, green, muted },
    },
  }: GluegunToolbox) => {
    const printHelp = () =>
      fancy(`${muted(`Supabase CLI ${version()}`)}

  ${bold(green('ϟ supabase'))} [options] [<command>]

  Commands:

    init                  Initialize project
    start                 Start local emulator
    stop                  Stop local emulator

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
