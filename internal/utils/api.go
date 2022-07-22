package utils

import "os"

var RegionMap = map[string]string{
	"ap-northeast-1": "Northeast Asia (Tokyo)",
	"ap-northeast-2": "Northeast Asia (Seoul)",
	"ap-south-1":     "South Asia (Mumbai)",
	"ap-southeast-1": "Southeast Asia (Singapore)",
	"ap-southeast-2": "Oceania (Sydney)",
	"ca-central-1":   "Canada (Central)",
	"eu-central-1":   "Central EU (Frankfurt)",
	"eu-west-1":      "West EU (Ireland)",
	"eu-west-2":      "West EU (London)",
	"sa-east-1":      "South America (São Paulo)",
	"us-east-1":      "East US (North Virginia)",
	"us-west-1":      "West US (North California)",
}

func GetSupabaseAPIHost() string {
	apiHost := os.Getenv("SUPABASE_INTERNAL_API_HOST")
	if apiHost == "" {
		apiHost = "https://api.supabase.io"
	}
	return apiHost
}

func GetSupabaseDashboardURL() string {
	switch GetSupabaseAPIHost() {
	case "https://api.supabase.com", "https://api.supabase.io":
		return "https://app.supabase.com"
	case "https://api.supabase.green":
		return "https://app.supabase.green"
	default:
		return "http://localhost:8082"
	}
}
