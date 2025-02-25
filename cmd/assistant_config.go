package cmd

import (
	"fmt"

	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/dna/config"
)

func newAssistantConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Manage DNA assistant configuration",
	}

	cmd.AddCommand(newAssistantConfigSetCmd())
	cmd.AddCommand(newAssistantConfigGetCmd())

	return cmd
}

func newAssistantConfigSetCmd() *cobra.Command {
	var apiKey, provider, model string
	var temperature float32

	cmd := &cobra.Command{
		Use:   "set",
		Short: "Set DNA assistant configuration values",
		RunE: func(cmd *cobra.Command, args []string) error {
			fs := afero.NewOsFs()
			cfg, err := config.Load(fs)
			if err != nil {
				// If config doesn't exist, start with defaults
				cfg = &config.DefaultConfig
			}

			// Update only provided values
			if apiKey != "" {
				cfg.APIKey = apiKey
			}
			if provider != "" {
				cfg.Provider = provider
			}
			if model != "" {
				cfg.Model = model
			}
			if cmd.Flags().Changed("temperature") {
				cfg.Temperature = temperature
			}

			if err := cfg.Save(fs); err != nil {
				return fmt.Errorf("error saving config: %w", err)
			}

			fmt.Println("Configuration updated successfully")
			return nil
		},
	}

	cmd.Flags().StringVar(&apiKey, "api-key", "", "OpenAI API key")
	cmd.Flags().StringVar(&provider, "provider", "", "AI provider (openai)")
	cmd.Flags().StringVar(&model, "model", "", "AI model (e.g., gpt-4)")
	cmd.Flags().Float32Var(&temperature, "temperature", 0.7, "Model temperature (0.0-1.0)")

	return cmd
}

func newAssistantConfigGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get",
		Short: "Display current DNA assistant configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(afero.NewOsFs())
			if err != nil {
				return fmt.Errorf("error loading config: %w", err)
			}

			fmt.Printf("Current configuration:\n")
			fmt.Printf("API Key: %s\n", maskAPIKey(cfg.APIKey))
			fmt.Printf("Provider: %s\n", cfg.Provider)
			fmt.Printf("Model: %s\n", cfg.Model)
			fmt.Printf("Temperature: %.2f\n", cfg.Temperature)

			return nil
		},
	}
}

func maskAPIKey(key string) string {
	if len(key) <= 8 {
		return "********"
	}
	return key[:4] + "..." + key[len(key)-4:]
}

func init() {
	assistantCmd.AddCommand(newAssistantConfigCmd())
}
