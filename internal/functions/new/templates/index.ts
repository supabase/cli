// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

console.log("Hello from Functions!")

Deno.serve(async (req) => {
  const { name } = await req.json()
  const data = {
    message: `Hello ${name}!`,
  }

  return new Response(
    JSON.stringify(data),
    { headers: { "Content-Type": "application/json" } },
  )
})

// To invoke locally:
// curl -i --location --request POST 'http://127.0.0.1:{{ .Port }}/functions/v1/{{ .Slug }}' \
//   --header 'Authorization: Bearer {{ .Token }}' \
//   --header 'Content-Type: application/json' \
//   --data '{"name":"Functions"}'
