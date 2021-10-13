const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(
  '<your_API_URL>',
  '<your_anon_key>'
)
supabase
  .from('boarders')
  .select()
  .then(({ data }) => console.log(data))
