package utils

import (
	_ "embed"
	"io/fs"
	"net"
	"net/url"
	"os"
	"strconv"

	"github.com/compose-spec/compose-go/v2/types"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/pkg/config"
)

var (
	NetId         string
	DbId          string
	KongId        string
	GotrueId      string
	InbucketId    string
	RealtimeId    string
	RestId        string
	StorageId     string
	ImgProxyId    string
	DifferId      string
	PgmetaId      string
	StudioId      string
	EdgeRuntimeId string
	LogflareId    string
	VectorId      string
	PoolerId      string

	DbAliases          = []string{"db", "db.supabase.internal"}
	KongAliases        = []string{"kong", "api.supabase.internal"}
	GotrueAliases      = []string{"auth"}
	InbucketAliases    = []string{"inbucket"}
	RealtimeAliases    = []string{"realtime", Config.Realtime.TenantId}
	RestAliases        = []string{"rest"}
	StorageAliases     = []string{"storage"}
	ImgProxyAliases    = []string{"imgproxy"}
	PgmetaAliases      = []string{"pg_meta"}
	StudioAliases      = []string{"studio"}
	EdgeRuntimeAliases = []string{"edge_runtime"}
	LogflareAliases    = []string{"analytics"}
	VectorAliases      = []string{"vector"}
	PoolerAliases      = []string{"pooler"}

	//go:embed templates/initial_schemas/13.sql
	InitialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	InitialSchemaPg14Sql string
)

func GetId(name string) string {
	return "supabase_" + name + "_" + Config.ProjectId
}

func UpdateDockerIds() {
	if NetId = viper.GetString("network-id"); len(NetId) == 0 {
		NetId = GetId("network")
	}
	DbId = GetId(DbAliases[0])
	KongId = GetId(KongAliases[0])
	GotrueId = GetId(GotrueAliases[0])
	InbucketId = GetId(InbucketAliases[0])
	RealtimeId = GetId(RealtimeAliases[0])
	RestId = GetId(RestAliases[0])
	StorageId = GetId(StorageAliases[0])
	ImgProxyId = GetId(ImgProxyAliases[0])
	DifferId = GetId("differ")
	PgmetaId = GetId(PgmetaAliases[0])
	StudioId = GetId(StudioAliases[0])
	EdgeRuntimeId = GetId(EdgeRuntimeAliases[0])
	LogflareId = GetId(LogflareAliases[0])
	VectorId = GetId(VectorAliases[0])
	PoolerId = GetId(PoolerAliases[0])
}

func GetDockerIds() []string {
	return []string{
		KongId,
		GotrueId,
		InbucketId,
		RealtimeId,
		RestId,
		StorageId,
		ImgProxyId,
		PgmetaId,
		StudioId,
		EdgeRuntimeId,
		LogflareId,
		VectorId,
		PoolerId,
	}
}

var Config = config.NewConfig(config.WithHostname(GetHostname()))

func GetServices() types.Services {
	services := types.Services{
		"db": {
			Name:       ShortContainerImageName(Config.Db.Image),
			Image:      GetRegistryImageUrl(Config.Db.Image),
			PullPolicy: types.PullPolicyMissing,
		},
	}
	if Config.Api.Enabled {
		services["gateway"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Api.KongImage),
			Image:      GetRegistryImageUrl(Config.Api.KongImage),
			PullPolicy: types.PullPolicyMissing,
		}
		services["api"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Api.Image),
			Image:      GetRegistryImageUrl(Config.Api.Image),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.Auth.Enabled {
		services["auth"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Auth.Image),
			Image:      GetRegistryImageUrl(Config.Auth.Image),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.Inbucket.Enabled {
		services["mailpit"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Inbucket.Image),
			Image:      GetRegistryImageUrl(Config.Inbucket.Image),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.Realtime.Enabled {
		services["realtime"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Realtime.Image),
			Image:      GetRegistryImageUrl(Config.Realtime.Image),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.Storage.Enabled {
		services["storage"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Storage.Image),
			Image:      GetRegistryImageUrl(Config.Storage.Image),
			PullPolicy: types.PullPolicyMissing,
		}
		services["imgProxy"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Storage.ImgProxyImage),
			Image:      GetRegistryImageUrl(Config.Storage.ImgProxyImage),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.EdgeRuntime.Enabled {
		services["edgeRuntime"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.EdgeRuntime.Image),
			Image:      GetRegistryImageUrl(Config.EdgeRuntime.Image),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.Studio.Enabled {
		services["studio"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Studio.Image),
			Image:      GetRegistryImageUrl(Config.Studio.Image),
			PullPolicy: types.PullPolicyMissing,
		}
		services["pgmeta"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Studio.PgmetaImage),
			Image:      GetRegistryImageUrl(Config.Studio.PgmetaImage),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.Analytics.Enabled {
		services["analytics"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Analytics.Image),
			Image:      GetRegistryImageUrl(Config.Analytics.Image),
			PullPolicy: types.PullPolicyMissing,
		}
		services["vector"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Analytics.VectorImage),
			Image:      GetRegistryImageUrl(Config.Analytics.VectorImage),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	if Config.Db.Pooler.Enabled {
		services["pooler"] = types.ServiceConfig{
			Name:       ShortContainerImageName(Config.Db.Pooler.Image),
			Image:      GetRegistryImageUrl(Config.Db.Pooler.Image),
			PullPolicy: types.PullPolicyMissing,
		}
	}
	return services
}

// Adapts fs.FS to support absolute paths
type rootFS struct {
	fsys afero.Fs
}

func (f *rootFS) Open(name string) (fs.File, error) {
	return f.fsys.Open(name)
}

func NewRootFS(fsys afero.Fs) fs.FS {
	return &rootFS{fsys: fsys}
}

func ToRealtimeEnv(addr config.AddressFamily) string {
	if addr == config.AddressIPv6 {
		return "-proto_dist inet6_tcp"
	}
	return "-proto_dist inet_tcp"
}

type InitParams struct {
	ProjectId   string
	UseOrioleDB bool
	Overwrite   bool
}

func InitConfig(params InitParams, fsys afero.Fs) error {
	c := config.NewConfig()
	c.ProjectId = params.ProjectId
	if params.UseOrioleDB {
		c.Experimental.OrioleDBVersion = "15.1.0.150"
	}
	// Create config file
	if err := MkdirIfNotExistFS(fsys, SupabaseDirPath); err != nil {
		return err
	}
	flag := os.O_WRONLY | os.O_CREATE
	if params.Overwrite {
		flag |= os.O_TRUNC
	} else {
		flag |= os.O_EXCL
	}
	f, err := fsys.OpenFile(ConfigPath, flag, 0644)
	if err != nil {
		return errors.Errorf("failed to create config file: %w", err)
	}
	defer f.Close()
	return c.Eject(f)
}

func WriteConfig(fsys afero.Fs, _test bool) error {
	return InitConfig(InitParams{}, fsys)
}

func GetApiUrl(path string) string {
	if len(Config.Api.ExternalUrl) > 0 {
		return Config.Api.ExternalUrl + path
	}
	hostPort := net.JoinHostPort(Config.Hostname,
		strconv.FormatUint(uint64(Config.Api.Port), 10),
	)
	apiUrl := url.URL{
		Scheme: "http",
		Host:   hostPort,
		Path:   path,
	}
	return apiUrl.String()
}
