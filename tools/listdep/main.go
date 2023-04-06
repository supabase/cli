package main

import (
	"encoding/json"
	"log"
	"os"
	"strings"

	"github.com/supabase/cli/internal/utils"
)

func main() {
	external := make([]string, 0)
	for _, img := range utils.ServiceImages {
		if !strings.HasPrefix(img, "supabase/") ||
			strings.HasPrefix(img, "supabase/logflare") {
			external = append(external, img)
		}
	}

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(external); err != nil {
		log.Fatal(err)
	}
}
