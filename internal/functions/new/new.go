package new

import (
	"errors"
	"fmt"
	"os"

	"github.com/supabase/cli/internal/utils"
)

func Run(slug string) error {
	// 1. Sanity checks.
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
		if _, err := os.Stat("supabase/functions/" + slug); !errors.Is(err, os.ErrNotExist) {
			return errors.New("Function " + utils.Aqua(slug) + " already exists locally.")
		}
	}

	// 2. Create new function.
	{
		if err := utils.MkdirIfNotExist("supabase"); err != nil {
			return err
		}
		if err := utils.MkdirIfNotExist("supabase/functions"); err != nil {
			return err
		}
		if err := utils.MkdirIfNotExist("supabase/functions/" + slug); err != nil {
			return err
		}
		if err := os.WriteFile(
			"supabase/functions/"+slug+"/index.ts",
			[]byte(`// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { serve } from "https://deno.land/std@0.131.0/http/server.ts"

console.log("Hello from Functions!")

serve(async (req) => {
  const { name } = await req.json()
  const data = {
    message: `+"`Hello ${name}!`"+`,
  }

  return new Response(
    JSON.stringify(data),
    { headers: { "Content-Type": "application/json" } },
  )
})

// To invoke:
// curl -i --location --request POST 'http://localhost:54321/functions/v1/' \
//   --header 'Authorization: Bearer `+utils.AnonKey+`' \
//   --header 'Content-Type: application/json' \
//   --data '{"name":"Functions"}'
`),
			0644,
		); err != nil {
			return err
		}
	}

	fmt.Println("Created new Function at " + utils.Bold("supabase/functions/"+slug))
	return nil
}
