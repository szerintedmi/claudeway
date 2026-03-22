# Cloudflare Tunnel & Access

## Tunnel Setup

Cloudflare Tunnel exposes the local WebSocket server to the internet securely — no port forwarding, no firewall changes. It makes outbound-only connections to Cloudflare's edge, which proxies traffic back to your local server with TLS. WebSocket (`wss://`) works automatically.

### Quick Tunnel (No Domain Required)

Temporary random URL, changes on every restart. Good for quick testing.

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8765
```

This prints a URL like `https://something-random.trycloudflare.com`. Connect your device to:

```
wss://something-random.trycloudflare.com/ws?token=YOUR_TOKEN
```

No Cloudflare account needed.

### Named Tunnel (Stable Subdomain)

Requires a Cloudflare account and a domain managed by Cloudflare.

#### 1. Login

```bash
cloudflared login
```

Opens a browser to authorize. Credentials are saved to `~/.cloudflared/`.

#### 2. Create the tunnel

```bash
cloudflared tunnel create claudeway
```

Note the tunnel UUID from the output.

#### 3. Configure

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: claudeway
credentials-file: /Users/you/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: claudeway.yourdomain.com
    service: http://localhost:8765
  - service: http_status:404
```

- Replace `<TUNNEL_UUID>` with the UUID from step 2
- Replace `claudeway.yourdomain.com` with your desired subdomain
- The final `- service: http_status:404` is a required catch-all for unmatched requests

#### 4. Add DNS route

```bash
cloudflared tunnel route dns claudeway claudeway.yourdomain.com
```

This creates a CNAME record in Cloudflare DNS automatically.

#### 5. Run

```bash
cloudflared tunnel run claudeway
```

Connect your device to:

```
wss://claudeway.yourdomain.com/ws?token=YOUR_TOKEN
```

### How It Works

```
Client → wss://claudeway.yourdomain.com → Cloudflare Edge (TLS) → cloudflared → ws://localhost:8765
```

Your local server stays plain `ws://`. Cloudflare terminates TLS and proxies WebSocket frames transparently. No server-side changes needed.

## Cloudflare Access (Zero-Trust Auth Layer)

The tunnel exposes the WebSocket server to the internet. Currently the only protection is a static bearer token. Adding Cloudflare Access provides a zero-trust auth layer in front of the tunnel — attackers can't reach the WebSocket without passing Cloudflare Access first, making the token a second factor.

### Scope

Two client types:
1. **Test UI (browser)** — interactive login (Google SSO / email OTP)
2. **Android companion app** — Service Token (machine-to-machine, no interactive login)

### Setup Steps

#### 1. Access Application (Cloudflare Dashboard)

- Create an Access Application for `claudeway.yourdomain.com`
- Add authentication policy (Google SSO, email OTP, or both)
- Create a Service Token for the Android app (generates Client ID + Client Secret pair)

#### 2. Android App — Service Token Headers

On every WebSocket connection, send:
- `CF-Access-Client-Id: <id>`
- `CF-Access-Client-Secret: <secret>`

Store these in the app's settings/preferences alongside the existing server URL and auth token. Update the connection settings UI to include the two new fields.

#### 3. Test UI — Browser Flow

No code changes needed — Cloudflare Access intercepts the browser request and handles the login flow automatically via redirect. Once authenticated, CF sets a cookie and subsequent requests (including WebSocket) pass through.

### Key Files

- `android/app/.../network/ClaudewayWebSocket.kt` — add CF headers
- `android/app/.../ui/ConnectionScreen.kt` — add CF credential fields
- `src/adapters/glasses/test-ui/index.html` — likely no changes needed

### Verification

- Access test UI via Cloudflare URL → should see CF login page first, then test UI works as before
- Android app connects with CF service token headers + app-level auth token → WebSocket connects
- Without CF credentials → connection rejected by Cloudflare before reaching the server
