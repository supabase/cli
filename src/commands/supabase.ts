
import { GluegunCommand } from 'gluegun'


const command: GluegunCommand = {
  name: 'supabase',
  run: async toolbox => {
    const { print } = toolbox

    print.info('supa init     # set up Supabase emulator in the current folder')
    print.info('supa dev      # start Supabase')
    print.info('supa eject    # eject the emulator to modify the stack manually')
    print.info('supa dump     # dump your database')
  },
}

module.exports = command
