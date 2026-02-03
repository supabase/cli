import dotenv from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

// Load .env from repo root
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../.env') })
import { Daytona, Image } from '@daytonaio/sdk'

const SNAPSHOT_NAME = 'supabase-remote-v4'

// Only pre-pull images that have network issues pulling at runtime
// Kong fails consistently from library/ namespace - other images pull fine
const IMAGES = {
  kong: 'library/kong:2.8.1',
}

async function main() {
  const apiKey = process.env.DAYTONA_API_KEY
  if (!apiKey) {
    console.error('DAYTONA_API_KEY environment variable is required')
    process.exit(1)
  }

  const daytona = new Daytona({ apiKey })

  console.log(`Building snapshot: ${SNAPSHOT_NAME}`)
  console.log('Base image: docker:28.3.2-dind-alpine3.22')
  console.log('')

  // Build image with Supabase services pre-pulled using crane (daemonless tool)
  // crane fetches image layers from registry without needing dockerd
  // saves as tarball -> docker load imports it at runtime
  const image = Image.base('docker:28.3.2-dind-alpine3.22')
    .runCommands(
      // Install crane
      'apk add --no-cache curl',
      'curl -sL https://github.com/google/go-containerregistry/releases/download/v0.20.2/go-containerregistry_Linux_x86_64.tar.gz | tar -xzf - -C /usr/local/bin crane',
      // Pre-pull only Kong (has network issues from library/ namespace)
      'mkdir -p /var/lib/supabase-images',
      `crane pull ${IMAGES.kong} /var/lib/supabase-images/kong.tar`,
      'ls -lh /var/lib/supabase-images/'
    )

  try {
    // Try to delete existing snapshot first
    console.log('Checking for existing snapshot...')
    try {
      const existing = await daytona.snapshot.get(SNAPSHOT_NAME)
      if (existing) {
        await daytona.snapshot.delete(existing)
        console.log('Deleted existing snapshot.')
      }
    } catch {
      // Snapshot doesn't exist, that's fine
    }

    console.log('Creating snapshot (this may take a few minutes)...')
    console.log('')

    await daytona.snapshot.create(
      {
        name: SNAPSHOT_NAME,
        image,
        resources: {
          cpu: 4,
          memory: 4, // 4 GiB
        },
      },
      {
        onLogs: (log: string) => process.stdout.write(log),
      }
    )

    console.log('')
    console.log(`Snapshot "${SNAPSHOT_NAME}" created successfully!`)
    console.log('')
    console.log('Update daytona.go to use this snapshot:')
    console.log(`  "snapshot": "${SNAPSHOT_NAME}"`)
  } catch (error) {
    console.error('Failed to create snapshot:', error)
    process.exit(1)
  }
}

main()
