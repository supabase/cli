package new

import (
	"errors"
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
		matched, err := regexp.MatchString(`^[A-Za-z0-9_-]+$`, slug)
		if err != nil {
			return err
		}
		if !matched {
			return errors.New("Invalid Function name. Must be `^[A-Za-z0-9_-]+$`.")
		}
	}

	// 3. Create new function.
	{
		if err := utils.MkdirIfNotExist("supabase/functions"); err != nil {
			return err
		}
		if err := os.WriteFile(
			"supabase/functions/"+slug+".ts",
			[]byte(`import { serve } from "https://deno.land/std/http/server.ts";

serve(() => new Response("Hello World"));
`),
			0644,
		); err != nil {
			return err
		}
	}

	return nil
}
