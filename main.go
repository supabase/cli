package main

import (
	"github.com/joho/godotenv"
	"github.com/supabase/cli/cmd"
)

func main() {
	godotenv.Load("supabase/.env")

	cmd.Execute()
}
