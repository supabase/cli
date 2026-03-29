package utils

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils/cloudflare"
	supabase "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

const (
	DNS_GO_NATIVE  = "native"
	DNS_OVER_HTTPS = "https"
)

var (
	clientOnce sync.Once
	apiClient  *supabase.ClientWithResponses

	DNSResolver = EnumFlag{
		Allowed: []string{DNS_GO_NATIVE, DNS_OVER_HTTPS},
		Value:   DNS_GO_NATIVE,
	}
)

// Performs DNS lookup via HTTPS, in case firewall blocks native netgo resolver.
func FallbackLookupIP(ctx context.Context, host string) ([]string, error) {
	if net.ParseIP(host) != nil {
		return []string{host}, nil
	}
	// Ref: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json
	cf := cloudflare.NewCloudflareAPI()
	data, err := cf.DNSQuery(ctx, cloudflare.DNSParams{Name: host})
	if err != nil {
		return nil, err
	}
	// Look for first valid IP
	var resolved []string
	for _, answer := range data.Answer {
		if answer.Type == cloudflare.TypeA || answer.Type == cloudflare.TypeAAAA {
			resolved = append(resolved, answer.Data)
		}
	}
	if len(resolved) == 0 {
		return nil, errors.Errorf("failed to locate valid IP for %s; resolves to %#v", host, data.Answer)
	}
	return resolved, nil
}

func ResolveCNAME(ctx context.Context, host string) (string, error) {
	// Ref: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json
	cf := cloudflare.NewCloudflareAPI()
	data, err := cf.DNSQuery(ctx, cloudflare.DNSParams{Name: host, Type: cast.Ptr(cloudflare.TypeCNAME)})
	if err != nil {
		return "", err
	}
	// Look for first valid IP
	for _, answer := range data.Answer {
		if answer.Type == cloudflare.TypeCNAME {
			return answer.Data, nil
		}
	}
	serialized, err := json.MarshalIndent(data.Answer, "", "    ")
	if err != nil {
		// we ignore the error (not great), and use the underlying struct in our error message
		return "", errors.Errorf("failed to locate appropriate CNAME record for %s; resolves to %+v", host, data.Answer)
	}
	return "", errors.Errorf("failed to locate appropriate CNAME record for %s; resolves to %+v", host, serialized)
}

type DialContextFunc func(context.Context, string, string) (net.Conn, error)

// Wraps a DialContext with DNS-over-HTTPS as fallback resolver
func withFallbackDNS(dialContext DialContextFunc) DialContextFunc {
	dnsOverHttps := func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.Errorf("failed to split host port: %w", err)
		}
		ip, err := FallbackLookupIP(ctx, host)
		if err != nil {
			return nil, err
		}
		conn, err := dialContext(ctx, network, net.JoinHostPort(ip[0], port))
		if err != nil {
			return nil, errors.Errorf("failed to dial fallback: %w", err)
		}
		return conn, nil
	}
	if DNSResolver.Value == DNS_OVER_HTTPS {
		return dnsOverHttps
	}
	nativeWithFallback := func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dialContext(ctx, network, address)
		// Workaround when pure Go DNS resolver fails https://github.com/golang/go/issues/12524
		if err, ok := err.(net.Error); ok && err.Timeout() {
			if conn, err := dnsOverHttps(ctx, network, address); err == nil {
				return conn, nil
			}
		}
		if err != nil {
			return nil, errors.Errorf("failed to dial native: %w", err)
		}
		return conn, nil
	}
	return nativeWithFallback
}

func GetSupabase() *supabase.ClientWithResponses {
	clientOnce.Do(func() {
		token, err := LoadAccessTokenFS(afero.NewOsFs())
		if err != nil {
			log.Fatalln(err)
		}
		if t, ok := http.DefaultTransport.(*http.Transport); ok {
			t.DialContext = withFallbackDNS(t.DialContext)
		}
		apiClient, err = supabase.NewClientWithResponses(
			GetSupabaseAPIHost(),
			supabase.WithRequestEditorFn(func(ctx context.Context, req *http.Request) error {
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("User-Agent", "SupabaseCLI/"+Version)
				return nil
			}),
		)
		if err != nil {
			log.Fatalln(err)
		}
	})
	return apiClient
}

// Used by unit tests
var DefaultApiHost = CurrentProfile.APIURL

func GetSupabaseAPIHost() string {
	return CurrentProfile.APIURL
}

func GetSupabaseDashboardURL() string {
	return CurrentProfile.DashboardURL
}

func GetSupabaseHost(projectRef string) string {
	return fmt.Sprintf("%s.%s", projectRef, CurrentProfile.ProjectHost)
}

func GetSupabaseDbHost(projectRef string) string {
	return "db." + GetSupabaseHost(projectRef)
}
