package new

import (
	"errors"
	"fmt"
	"os"
	"regexp"

	"github.com/supabase/cli/internal/utils"
)

func Run(slug string) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
	}

	// 2. Validate Function slug.
	{
		matched, err := regexp.MatchString(`^[A-Za-z][A-Za-z0-9_-]*$`, slug)
		if err != nil {
			return err
		}
		if !matched {
			return errors.New("Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)")
		}
		if _, err := os.Stat("supabase/functions/" + slug + ".ts"); !errors.Is(err, os.ErrNotExist) {
			return errors.New("Function " + utils.Aqua(slug) + " already exists locally.")
		}
	}

	// 3. Create new function.
	{
		if err := utils.MkdirIfNotExist("supabase/functions"); err != nil {
			return err
		}
		if err := os.WriteFile(
			"supabase/functions/"+slug+".ts",
			[]byte(`// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { serve } from "https://deno.land/std@0.131.0/http/server.ts"

console.log("Hello from Functions!")

serve(() => new Response(
    '{"message":"Hello from Functions!"}',
    { headers: { "Content-Type": "application/json" } },
))
`),
			0644,
		); err != nil {
			return err
		}
	}

	fmt.Println("Created new Function at " + utils.Bold("supabase/functions/"+slug+".ts"))
	return nil
}
