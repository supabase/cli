const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(
  '<your_API_URL>',
  '<your_anon_key>'
)
supabase
  .from('my_table')
  .select()
  .then(({ data }) => console.log(data))
