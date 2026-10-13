# SearXNG with Docker Compose

This deployment runs the official SearXNG image with Valkey-backed rate
limiting. Cloudflare Tunnel provides public HTTPS without router port
forwarding. It connects to Caddy inside the Docker network; Caddy requires
HTTP Basic Auth before forwarding requests to SearXNG. No service ports are
published on the Mac mini.

## Requirements

- A Mac mini with Docker Desktop installed and running
- A Cloudflare account and a domain managed by Cloudflare DNS
- A remotely-managed Cloudflare Tunnel

No router port forwarding is needed. The Mac mini only needs outbound internet
access so `cloudflared` can connect to Cloudflare.

Install Docker Desktop on the Mac mini, start it, and enable launch at login.
Also configure macOS not to put the Mac mini to sleep; otherwise the tunnel and
search service will be unavailable while it sleeps.

## Configure and start

Get the project files onto the Mac mini (for example, by checking out the
repository), then open a terminal in `infra/searxng`:

1. Copy `.env.example` to `.env`.
2. In the Cloudflare dashboard, create a remotely-managed tunnel and copy its
   connector token into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`. Treat this token
   as a secret; anyone with it can run a connector for the tunnel.
3. In the tunnel's **Public Hostnames** settings, add the hostname used in
   `SEARXNG_BASE_URL` and route it to `http://caddy:80`.
4. Generate a SearXNG secret:

   ```sh
   openssl rand -hex 32
   ```

   Put the output in `SEARXNG_SECRET` in `.env`.

5. Choose a long Basic Auth password and generate its bcrypt hash:

   ```sh
   docker run --rm caddy:2-alpine \
     caddy hash-password --plaintext 'replace-this-with-your-password'
   ```

   Put the hash in `SEARXNG_AUTH_PASSWORD_HASH`. Do not commit `.env` or share
   the password/hash in chat.

6. Start the services:

   ```sh
   docker compose up -d
   docker compose ps
   docker compose logs -f cloudflared
   docker compose logs -f searxng
   ```

7. Test JSON search output:

   ```sh
   curl --user 'api:YOUR_PASSWORD' \
     'https://search.example.com/search?q=Taiwan+stock+market&format=json'
   ```

The response should be JSON with a `results` array. SearXNG's HTML and JSON
formats are enabled in `core-config/settings.yml`.

## Operations

```sh
docker compose pull
docker compose up -d
docker compose logs -f
docker compose down
```

The named volumes preserve SearXNG cache, Valkey data, and Caddy state.
`docker compose down -v` also deletes those volumes; do not use it unless you
intend to remove that data.

## Connect the existing Vercel API

In the Vercel project settings, add these environment variables to the API
deployment:

- `SEARXNG_BASE_URL`: the same public HTTPS URL configured for the Cloudflare
  Tunnel hostname, for example `https://search.example.com/`
- `SEARXNG_AUTH_USERNAME`: the Basic Auth username configured in this
  directory's `.env`
- `SEARXNG_AUTH_PASSWORD`: the matching plaintext password (not the bcrypt
  hash). Store it as a protected Vercel environment variable.

The API sends these credentials only to the HTTPS SearXNG endpoint. LINE uses
Google News RSS when `LINE_WEB_SEARCH_PROVIDER` is unset. Set the variable to
`searxng` only after the Mac mini tunnel is running and the admin availability
diagnostic succeeds, if you want LINE searches to use that self-hosted instance.

The endpoint uses HTTP Basic Auth to avoid exposing an unrestricted public
search proxy. Keep `.env` private, never paste credentials into chat or logs,
and rotate the password if it is exposed.
