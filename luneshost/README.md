# LunesHost WebSocket Relay

Drop-in WS relay for Veltrix agents. Runs on `node70.lunes.host:3242`.

## Setup

```bash
# Upload luneshost/ folder to the server, then:
cd luneshost
npm install
node server.js
# or use pm2:
npm install -g pm2
pm2 start server.js --name luneshost-ws
pm2 save
```

## Usage

Agents connect to `ws://node70.lunes.host:3242?role=agent&device=<id>&key=<auth_key>`

Viewers connect to `ws://node70.lunes.host:3242?role=viewer&device=<id>&key=<auth_key>`

Add this URL as a relay endpoint in Admin > Endpoints.
