package utils

import (
	"context"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/deepmap/oapi-codegen/pkg/securityprovider"
	"github.com/spf13/viper"
	supabase "github.com/supabase/cli/pkg/api"
)

var (
	clientOnce sync.Once
	apiClient  *supabase.ClientWithResponses
)

func GetSupabase() *supabase.ClientWithResponses {
	clientOnce.Do(func() {
		token, err := LoadAccessToken()
		if err != nil {
			log.Fatalln(err)
		}
		provider, err := securityprovider.NewSecurityProviderBearerToken(token)
		if err != nil {
			log.Fatalln(err)
		}
		// Setup fallback resolver on default transport
		dialer := &net.Dialer{Timeout: 15 * time.Second}
		dialer.Resolver = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				// Go resolver may not work on macOS https://github.com/golang/go/issues/12524
				conn, err := dialer.DialContext(ctx, network, address)
				if err != nil {
					// Retry with CloudFlare DNS resolver
					return dialer.DialContext(ctx, "udp", "1.1.1.1:53")
				}
				return conn, err
			},
		}
		if t, ok := http.DefaultTransport.(*http.Transport); ok {
			t.DialContext = dialer.DialContext
		}
		apiClient, err = supabase.NewClientWithResponses(
			GetSupabaseAPIHost(),
			supabase.WithRequestEditorFn(provider.Intercept),
		)
		if err != nil {
			log.Fatalln(err)
		}
	})
	return apiClient
}

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
	apiHost := viper.GetString("INTERNAL_API_HOST")
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
