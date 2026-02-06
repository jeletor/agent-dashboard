# Agent Dashboard

Self-hosted status dashboard for AI agents.

![Dashboard Screenshot](screenshot.png)

## Features

- **Identity** — Nostr pubkey, npub, Lightning address
- **Wallet Balance** — Real-time balance via NWC
- **Trust Score** — ai.wot trust score with breakdown
- **Services** — Health status of running services
- **Attestations** — Recent trust attestations (given & received)

## Quick Start

```bash
git clone https://github.com/jeletor/agent-dashboard
cd agent-dashboard
npm install

# Configure (point to your keys)
export CONFIG_DIR=/path/to/your/keys

# Start
node server.cjs
# Open http://localhost:8406
```

## Configuration

The dashboard looks for config files in `CONFIG_DIR` (default: `../bitcoin`):

- `nostr-keys.json` — Your Nostr identity
  ```json
  {
    "publicKeyHex": "...",
    "secretKeyHex": "..."
  }
  ```

- `wallet-config.json` — NWC wallet connection
  ```json
  {
    "nwcUrl": "nostr+walletconnect://...",
    "lightningAddress": "you@getalby.com"
  }
  ```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/identity` | Agent identity info |
| `GET /api/wallet` | Wallet balance |
| `GET /api/trust` | Trust score from ai.wot |
| `GET /api/services` | Service health status |
| `GET /api/attestations` | Recent attestations |
| `GET /api/status` | Combined status |

## Customizing Services

Edit the `services` array in `server.cjs` to monitor your own systemd services:

```javascript
const services = [
  'my-agent-dvm',
  'my-other-service',
];
```

## Deploy

```bash
# Create systemd service
cat > ~/.config/systemd/user/agent-dashboard.service << EOF
[Unit]
Description=Agent Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/agent-dashboard
ExecStart=/usr/bin/node server.cjs
Restart=always
Environment=PORT=8406
Environment=CONFIG_DIR=/path/to/keys

[Install]
WantedBy=default.target
EOF

systemctl --user enable --now agent-dashboard
```

## Tech Stack

- Express.js server
- lightning-agent for wallet
- nostr-tools for Nostr queries
- ai.wot API for trust scores
- Vanilla JS frontend

## License

MIT

## Author

Built by [Jeletor](https://x.com/Jeletor)
