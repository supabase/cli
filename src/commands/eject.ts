import { GluegunToolbox } from 'gluegun'

module.exports = {
  name: 'eject',
  alias: ['e'],
  run: async (toolbox: GluegunToolbox) => {
    const {
      // parameters,
      template: { generate },
      print: { info },
    } = toolbox

    await generate({
      template: 'init/emulator.yml',
      target: `./docker-compose.yml`,
    })

    info(`Ejected.`)
  },
}
