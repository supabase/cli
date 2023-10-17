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

	"github.com/spf13/viper"
	supabase "github.com/supabase/cli/pkg/api"
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

const (
	// Ref: https://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml#dns-parameters-4
	dnsIPv4Type uint16 = 1
	cnameType   uint16 = 5
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
func FallbackLookupIP(ctx context.Context, host string) ([]string, error) {
	if net.ParseIP(host) != nil {
		return []string{host}, nil
	}
	// Ref: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json
	url := "https://1.1.1.1/dns-query?name=" + host
	data, err := JsonResponse[dnsResponse](ctx, http.MethodGet, url, nil, func(ctx context.Context, req *http.Request) error {
		req.Header.Add("accept", "application/dns-json")
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Look for first valid IP
	var resolved []string
	for _, answer := range data.Answer {
		if answer.Type == dnsIPv4Type || answer.Type == dnsIPv6Type {
			resolved = append(resolved, answer.Data)
		}
	}
	if len(resolved) == 0 {
		err = fmt.Errorf("failed to locate valid IP for %s; resolves to %#v", host, data.Answer)
	}
	return resolved, err
}

func ResolveCNAME(ctx context.Context, host string) (string, error) {
	// Ref: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json
	url := fmt.Sprintf("https://1.1.1.1/dns-query?name=%s&type=CNAME", host)
	data, err := JsonResponse[dnsResponse](ctx, http.MethodGet, url, nil, func(ctx context.Context, req *http.Request) error {
		req.Header.Add("accept", "application/dns-json")
		return nil
	})
	if err != nil {
		return "", err
	}
	// Look for first valid IP
	for _, answer := range data.Answer {
		if answer.Type == cnameType {
			return answer.Data, nil
		}
	}
	serialized, err := json.MarshalIndent(data.Answer, "", "    ")
	if err != nil {
		// we ignore the error (not great), and use the underlying struct in our error message
		return "", fmt.Errorf("failed to locate appropriate CNAME record for %s; resolves to %+v", host, data.Answer)
	}
	return "", fmt.Errorf("failed to locate appropriate CNAME record for %s; resolves to %+v", host, serialized)
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

type DialContextFunc func(context.Context, string, string) (net.Conn, error)

// Wraps a DialContext with DNS-over-HTTPS as fallback resolver
func withFallbackDNS(dialContext DialContextFunc) DialContextFunc {
	dnsOverHttps := func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ip, err := FallbackLookupIP(ctx, host)
		if err != nil {
			return nil, err
		}
		return dialContext(ctx, network, net.JoinHostPort(ip[0], port))
	}
	if DNSResolver.Value == DNS_OVER_HTTPS {
		return dnsOverHttps
	}
	nativeWithFallback := func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dialContext(ctx, network, address)
		// Workaround when pure Go DNS resolver fails https://github.com/golang/go/issues/12524
		if err, ok := err.(net.Error); ok && err.Timeout() {
			if conn, err := dnsOverHttps(ctx, network, address); err == nil {
				return conn, err
			}
		}
		return conn, err
	}
	return nativeWithFallback
}

func GetSupabase() *supabase.ClientWithResponses {
	clientOnce.Do(func() {
		token, err := LoadAccessToken()
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

const (
	DefaultApiHost = "https://api.supabase.com"
	// DEPRECATED
	DeprecatedApiHost = "https://api.supabase.io"
)

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
	"eu-west-3":      "West EU (Paris)",
	"sa-east-1":      "South America (São Paulo)",
	"us-east-1":      "East US (North Virginia)",
	"us-west-1":      "West US (North California)",
	"us-west-2":      "West US (Oregon)",
}

var FlyRegions = map[string]string{
	"ams": "Amsterdam, Netherlands",
	"arn": "Stockholm, Sweden",
	"bog": "Bogotá, Colombia",
	"bos": "Boston, Massachusetts (US)",
	"cdg": "Paris, France",
	"den": "Denver, Colorado (US)",
	"dfw": "Dallas, Texas (US",
	"ewr": "Secaucus, NJ (US)",
	"fra": "Frankfurt, Germany",
	"gdl": "Guadalajara, Mexico",
	"gig": "Rio de Janeiro, Brazil",
	"gru": "Sao Paulo, Brazil",
	"hkg": "Hong Kong, Hong Kong",
	"iad": "Ashburn, Virginia (US",
	"jnb": "Johannesburg, South Africa",
	"lax": "Los Angeles, California (US",
	"lhr": "London, United Kingdom",
	"maa": "Chennai (Madras), India",
	"mad": "Madrid, Spain",
	"mia": "Miami, Florida (US)",
	"nrt": "Tokyo, Japan",
	"ord": "Chicago, Illinois (US",
	"otp": "Bucharest, Romania",
	"qro": "Querétaro, Mexico",
	"scl": "Santiago, Chile",
	"sea": "Seattle, Washington (US",
	"sin": "Singapore, Singapore",
	"sjc": "San Jose, California (US",
	"syd": "Sydney, Australia",
	"waw": "Warsaw, Poland",
	"yul": "Montreal, Canada",
	"yyz": "Toronto, Canada",
}

func GetSupabaseAPIHost() string {
	apiHost := viper.GetString("INTERNAL_API_HOST")
	if apiHost == "" {
		apiHost = DefaultApiHost
	}
	return apiHost
}

func GetSupabaseDashboardURL() string {
	switch GetSupabaseAPIHost() {
	case DefaultApiHost, DeprecatedApiHost:
		return "https://supabase.com/dashboard"
	case "https://api.supabase.green":
		return "https://app.supabase.green"
	default:
		return "http://localhost:8082"
	}
}

func GetSupabaseDbHost(projectRef string) string {
	// TODO: query projects api for db_host
	switch GetSupabaseAPIHost() {
	case DefaultApiHost, DeprecatedApiHost:
		return fmt.Sprintf("db.%s.supabase.co", projectRef)
	case "https://api.supabase.green":
		return fmt.Sprintf("db.%s.supabase.red", projectRef)
	default:
		return fmt.Sprintf("db.%s.supabase.red", projectRef)
	}
}

func GetSupabaseHost(projectRef string) string {
	switch GetSupabaseAPIHost() {
	case DefaultApiHost, DeprecatedApiHost:
		return fmt.Sprintf("%s.supabase.co", projectRef)
	case "https://api.supabase.green":
		return fmt.Sprintf("%s.supabase.red", projectRef)
	default:
		return fmt.Sprintf("%s.supabase.red", projectRef)
	}
}
