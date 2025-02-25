package cmd

import (
	"fmt"
	"strings"

	"github.com/fatih/color"
)

// UI elements shared across assistant commands
var (
	// Initialize color outputs for PowerShell compatibility
	bannerColor    = color.New(color.FgGreen)    // Color for banners and prompts
	assistantColor = color.New(color.FgCyan)     // Color for assistant responses
	commandColor   = color.New(color.FgYellow)   // Color for command names
	separatorColor = color.New(color.FgHiBlack)  // For the separator lines
	errorColor     = color.New(color.FgRed)      // Color for error messages
	toolColor      = color.RGB(0xF8, 0x83, 0x79) // Coral color for tool output (F88379)

	separator     = separatorColor.Sprint(strings.Repeat("=", 50)) // Create a string of 50 equals signs
	toolSeparator = separatorColor.Sprint(strings.Repeat("-", 30)) // Shorter separator for tools
	prompt        = separatorColor.Sprint("\n> ")                  // For user input

	helpText = fmt.Sprintf(`%s
Welcome to the DNA Assistant. Available commands:
  %s    - End the chat session
  %s    - Show this help message
  %s   - Clear chat history

%s
%s
%s`,
		separator,
		commandColor.Sprint("exit"),
		commandColor.Sprint("help"),
		commandColor.Sprint("clear"),
		bannerColor.Sprint("Type your questions about database design and normalization."),
		assistantColor.Sprint("Press Ctrl+C at any time to exit."),
		separator)
)

// handleChatResponse formats and prints chat responses
func handleChatResponse(response string) {
	switch response {
	case "exit":
		fmt.Fprintln(color.Output, separator)
		bannerColor.Fprintln(color.Output, "Goodbye! Feel free to return if you need more database design assistance.")
		fmt.Fprintln(color.Output, separator)
	case "help":
		fmt.Fprint(color.Output, helpText)
	case "clear":
		fmt.Fprintln(color.Output, separator)
		bannerColor.Sprint("Chat history cleared.")
		fmt.Fprintln(color.Output, separator)
	default:
		fmt.Fprintln(color.Output, separator)
		assistantColor.Fprintln(color.Output, response)
		fmt.Fprintln(color.Output, separator)
	}
}
