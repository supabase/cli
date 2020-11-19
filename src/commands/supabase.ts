
import { GluegunCommand } from 'gluegun'


const command: GluegunCommand = {
  name: 'supabase',
  run: async toolbox => {
    const { print } = toolbox

    print.info('Run supabase --help')
  },
}

module.exports = command
