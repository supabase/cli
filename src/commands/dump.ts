import { GluegunToolbox } from 'gluegun'

import { PostgresMeta } from '@supabase/postgres-meta'
export const pg = new PostgresMeta({
  connectionString: 'postgres://docker:postgres@localhost:5432/postgres'
})

module.exports = {
  name: 'dump',
  run: async (toolbox: GluegunToolbox) => {
    const {
      // parameters,
      template: { generate },
      print: { info }
    } = toolbox

    try {
      const { data: tables } = await pg.table.list()
      const { data: columns } = await pg.column.list()
      if (!tables || !columns) {
        throw 'No schema'
      }
      const schemas = new Set()
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i]
        schemas.add(table.schema)
        const tableColumns = columns
          .filter(x => x.table_id == table.id)
          .sort((a, b) => a.name.localeCompare(b.name))
        info(`Table: ${table.schema}.${table.name}`)
        await generate({
          template: 'dump/table.sql.ejs',
          target: `database/models/${table.schema}.${table.name}/_init.sql`,
          props: { table }
        })
        await generate({
          template: 'dump/columns.sql.ejs',
          target: `database/models/${table.schema}.${table.name}/columns.sql`,
          props: { table, columns: tableColumns }
        })
      }
      await generate({
        template: 'dump/models.sql.ejs',
        target: `database/models/_init.sql`,
        props: { schemas: Array.from(schemas), tables }
      })

      const { data: types } = await pg.type.list()

      for (let i = 0; i < types.length; i++) {
        const type = types[i]
        info(`Type: ${type.schema}.${type.name}`)
        await generate({
          template: 'dump/type.sql.ejs',
          target: `database/types/${type.schema}.${type.name}.sql`,
          props: { type }
        })
      }
    } catch (error) {
      console.log('error', error)
    }
  }
}
