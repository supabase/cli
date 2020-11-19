import { GluegunToolbox } from 'gluegun'
const {spawn} = require('child_process')

module.exports = {
  name: 'stop',
  run: async (toolbox: GluegunToolbox) => {
    let currentDir = toolbox.filesystem.path()

    try {
      let child = spawn('docker-compose', [
        '-f',
        `${currentDir}/.supabase/emulator.yml`,
        `down`
      ])
      child.stdout.pipe(process.stdout)

    } catch (error) {
      console.log('error', error)
    }
  }
}
