package main

import (
	"encoding/json"
	"log"
	"os"
	"strings"

	"github.com/supabase/cli/internal/utils"
)

func main() {
	images := []string{
		utils.GotrueImage,
		utils.RealtimeImage,
		utils.StorageImage,
		utils.KongImage,
		utils.InbucketImage,
		utils.PostgrestImage,
		utils.DifferImage,
		utils.MigraImage,
		utils.PgmetaImage,
		utils.StudioImage,
		utils.DenoRelayImage,
	}

	external := make([]string, 0)
	for _, img := range images {
		if !strings.HasPrefix(img, "supabase/") {
			external = append(external, img)
		}
	}

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(external); err != nil {
		log.Fatal(err)
	}
}
