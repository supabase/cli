package cmd

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/sashabaranov/go-openai"
)

type ToolResponse struct {
	Result  string `json:"result"`
	Success bool   `json:"success"`
}

func handleToolCall(toolCall *openai.FunctionCall) (*ToolResponse, error) {
	switch toolCall.Name {
	case "search_supabase_docs":
		var params struct {
			Query string `json:"query"`
			Topic string `json:"topic"`
		}
		if err := json.Unmarshal([]byte(toolCall.Arguments), &params); err != nil {
			return nil, err
		}
		return searchDocs(params.Query, params.Topic)

	case "analyze_schema":
		var params struct {
			Table string `json:"table"`
		}
		if err := json.Unmarshal([]byte(toolCall.Arguments), &params); err != nil {
			return nil, err
		}
		return analyzeSchema(params.Table)

	case "analyze_functions":
		var params struct {
			Name   string `json:"name"`
			Schema string `json:"schema"`
		}
		if err := json.Unmarshal([]byte(toolCall.Arguments), &params); err != nil {
			return nil, err
		}
		if params.Schema == "" {
			params.Schema = "public"
		}
		return analyzeFunctions(params.Name, params.Schema)

	case "get_cli_help":
		var params struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal([]byte(toolCall.Arguments), &params); err != nil {
			return nil, err
		}
		return getCliHelp(params.Command)
	}

	return nil, fmt.Errorf("unknown tool: %s", toolCall.Name)
}

func getCliHelp(command string) (*ToolResponse, error) {
	var output strings.Builder

	// Get help for main command or subcommand
	cmd := rootCmd
	if command != "" {
		for _, subcmd := range rootCmd.Commands() {
			if subcmd.Name() == command {
				cmd = subcmd
				break
			}
		}
	}

	cmd.SetOut(&output)
	cmd.HelpFunc()(cmd, []string{})

	return &ToolResponse{
		Success: true,
		Result:  output.String(),
	}, nil
}
