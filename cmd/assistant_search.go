package cmd

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"net/url"
)

type SearchResult struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Description string `json:"description"`
}

func searchDocs(query string, topic string) (*ToolResponse, error) {
	// Build search URL
	baseURL := "https://supabase.com/docs/search"
	params := url.Values{}
	params.Add("q", query)
	if topic != "" {
		params.Add("topic", topic)
	}

	// Make request
	resp, err := http.Get(baseURL + "?" + params.Encode())
	if err != nil {
		return &ToolResponse{
			Success: false,
			Result:  fmt.Sprintf("Error searching docs: %v", err),
		}, nil
	}
	defer resp.Body.Close()

	// Read response
	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return &ToolResponse{
			Success: false,
			Result:  fmt.Sprintf("Error reading response: %v", err),
		}, nil
	}

	// Format results nicely
	var results []SearchResult
	if err := json.Unmarshal(body, &results); err != nil {
		return &ToolResponse{
			Success: false,
			Result:  fmt.Sprintf("Error parsing results: %v", err),
		}, nil
	}

	// Build formatted response
	var formattedResult string
	for _, result := range results {
		formattedResult += fmt.Sprintf("\n📚 %s\n🔗 %s\n📝 %s\n",
			result.Title,
			result.URL,
			result.Description,
		)
	}

	return &ToolResponse{
		Success: true,
		Result:  formattedResult,
	}, nil
}
