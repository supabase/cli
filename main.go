package main

import (
	"github.com/joho/godotenv"
	"github.com/supabase/cli/cmd"
)

func main() {
	_ = godotenv.Load("supabase/.env")

	cmd.Execute()
}
