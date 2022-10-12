package utils

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"sync"

	"github.com/deepmap/oapi-codegen/pkg/securityprovider"
	"github.com/spf13/viper"
	supabase "github.com/supabase/cli/pkg/api"
)

var (
	clientOnce sync.Once
	apiClient  *supabase.ClientWithResponses
)

const (
	// Ref: https://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml#dns-parameters-4
	dnsIPv4Type uint16 = 1
	dnsIPv6Type uint16 = 28
)

type dnsAnswer struct {
	Type uint16 `json:"type"`
	Data string `json:"data"`
}

type dnsResponse struct {
	Answer []dnsAnswer `json:",omitempty"`
}

// Performs DNS lookup via HTTPS, in case firewall blocks native netgo resolver.
func fallbackLookupIP(ctx context.Context, address string) string {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return ""
	}
	// Ref: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json
	req, err := http.NewRequestWithContext(ctx, "GET", "https://1.1.1.1/dns-query?name="+host, nil)
	if err != nil {
		return ""
	}
	req.Header.Add("accept", "application/dns-json")
	// Sends request
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	// Parses response
	var data dnsResponse
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&data); err != nil {
		return ""
	}
	// Look for first valid IP
	for _, answer := range data.Answer {
		if answer.Type == dnsIPv4Type || answer.Type == dnsIPv6Type {
			return net.JoinHostPort(answer.Data, port)
		}
	}
	return ""
}

func WithTraceContext(ctx context.Context) context.Context {
	trace := &httptrace.ClientTrace{
		DNSStart: func(info httptrace.DNSStartInfo) {
			log.Printf("DNS Start: %+v\n", info)
		},
		DNSDone: func(info httptrace.DNSDoneInfo) {
			if info.Err != nil {
				log.Println("DNS Error:", info.Err)
			} else {
				log.Printf("DNS Done: %+v\n", info)
			}
		},
		ConnectStart: func(network, addr string) {
			log.Println("Connect Start:", network, addr)
		},
		ConnectDone: func(network, addr string, err error) {
			if err != nil {
				log.Println("Connect Error:", network, addr, err)
			} else {
				log.Println("Connect Done:", network, addr)
			}
		},
		TLSHandshakeStart: func() {
			log.Println("TLS Start")
		},
		TLSHandshakeDone: func(cs tls.ConnectionState, err error) {
			if err != nil {
				log.Println("TLS Error:", err)
			} else {
				log.Printf("TLS Done: %+v\n", cs)
			}
		},
		WroteHeaderField: func(key string, value []string) {
			log.Println("Sent Header:", key, value)
		},
		WroteRequest: func(wr httptrace.WroteRequestInfo) {
			if wr.Err != nil {
				log.Println("Send Error:", wr.Err)
			} else {
				log.Println("Send Done")
			}
		},
		Got1xxResponse: func(code int, header textproto.MIMEHeader) error {
			log.Println("Recv 1xx:", code, header)
			return nil
		},
		GotFirstResponseByte: func() {
			log.Println("Recv First Byte")
		},
	}
	return httptrace.WithClientTrace(ctx, trace)
}

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
		if t, ok := http.DefaultTransport.(*http.Transport); ok {
			dialContext := t.DialContext
			t.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				conn, err := dialContext(ctx, network, address)
				// Workaround when pure Go DNS resolver fails https://github.com/golang/go/issues/12524
				if err, ok := err.(*net.OpError); ok && err.Op == "dial" {
					if ip := fallbackLookupIP(ctx, address); ip != "" {
						return dialContext(ctx, network, ip)
					}
				}
				return conn, err
			}
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

func GetSupabaseDbHost(projectRef string) string {
	// TODO: query projects api for db_host
	switch GetSupabaseAPIHost() {
	case "https://api.supabase.com", "https://api.supabase.io":
		return fmt.Sprintf("db.%s.supabase.co", projectRef)
	case "https://api.supabase.green":
		return fmt.Sprintf("db.%s.supabase.red", projectRef)
	default:
		return fmt.Sprintf("db.%s.supabase.red", projectRef)
	}
}
