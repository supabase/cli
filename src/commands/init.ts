import { GluegunToolbox } from 'gluegun'
import ignore from 'ignore'

export default {
  name: 'init',
  run: async ({
    filesystem: { append, read, exists },
    template: { generate },
    print: {
      colors: { highlight },
      spin,
    },
  }: GluegunToolbox) => {
    const spinner = spin('Initializing project...')

    if (exists('.supabase')) {
      spinner.fail(`Project already initialized. Remove ${highlight('.supabase')} to reinitialize.`)
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

    // Write templates
    await Promise.all(
      ['README.txt', 'config.json', 'emulator.yml'].map((f) =>
        generate({
          template: `init/${f}`,
          target: `.supabase/${f}`,
        })
      )
    )

    spinner.succeed('Project initialized.')
  },
}
