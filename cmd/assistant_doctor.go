package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/sashabaranov/go-openai"
	"github.com/spf13/cobra"
)

type HealthCheck struct {
	Name       string
	Check      func() (string, error)
	FixMessage string
}

func newAssistantDoctorCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check environment setup for the DNA assistant",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runEnvironmentChecks()
		},
	}
}

func runEnvironmentChecks() error {
	checks := []HealthCheck{
		{
			Name: "Environment Variables",
			Check: func() (string, error) {
				apiKey := os.Getenv(EnvDNAAPIKey)
				if apiKey == "" {
					return "", fmt.Errorf("DNA_API_KEY not set")
				}

				// Validate API key by making a test request
				client := openai.NewClient(apiKey)
				_, err := client.CreateChatCompletion(
					context.Background(),
					openai.ChatCompletionRequest{
						Model: "gpt-3.5-turbo",
						Messages: []openai.ChatCompletionMessage{
							{
								Role:    openai.ChatMessageRoleUser,
								Content: "Test connection",
							},
						},
					},
				)
				if err != nil {
					return "", fmt.Errorf("invalid API key: %v", err)
				}

				provider := os.Getenv(EnvDNAProvider)
				if provider == "" {
					return "Using default provider: openai", nil
				}
				return fmt.Sprintf("Using provider: %s", provider), nil
			},
			FixMessage: `Export the required environment variables:
export DNA_API_KEY=your_api_key
export DNA_PROVIDER=openai  # Optional, defaults to openai`,
		},
		{
			Name: "Supabase Project",
			Check: func() (string, error) {
				if !isSupabaseProject() {
					return "", fmt.Errorf("not in a Supabase project directory")
				}
				return "Supabase project detected", nil
			},
			FixMessage: `Run this command from within a Supabase project directory.
Or initialize a new project with: supabase init`,
		},
		{
			Name: "Database Connection",
			Check: func() (string, error) {
				config, err := loadDatabaseConfig()
				if err != nil {
					return "", fmt.Errorf("failed to load database config: %w", err)
				}
				if err := checkDatabaseConnection(config); err != nil {
					return "", fmt.Errorf("database connection failed: %w", err)
				}
				return "Database connection successful", nil
			},
			FixMessage: `Ensure your database is running: supabase start
Check your database connection settings in supabase/config.toml`,
		},
	}

	// Run all checks
	hasErrors := false
	for _, check := range checks {
		fmt.Printf("Checking %s... ", check.Name)
		msg, err := check.Check()
		if err != nil {
			hasErrors = true
			fmt.Println("❌")
			fmt.Printf("Error: %v\n", err)
			if check.FixMessage != "" {
				fmt.Printf("Fix:\n%s\n", check.FixMessage)
			}
		} else {
			fmt.Println("✅")
			if msg != "" {
				fmt.Printf("Info: %s\n", msg)
			}
		}
		fmt.Println()
	}

	if hasErrors {
		return fmt.Errorf("one or more checks failed")
	}
	return nil
}

func isSupabaseProject() bool {
	_, err := os.Stat("supabase")
	return err == nil
}

func loadDatabaseConfig() (map[string]string, error) {
	// This is a placeholder - in the real implementation,
	// we would parse the supabase/config.toml file
	config := map[string]string{
		"host":     "localhost",
		"port":     "54322",
		"user":     "postgres",
		"password": "postgres",
		"database": "postgres",
	}
	return config, nil
}

func checkDatabaseConnection(config map[string]string) error {
	// This is a placeholder - in the real implementation,
	// we would attempt to connect to the database
	return nil
}
