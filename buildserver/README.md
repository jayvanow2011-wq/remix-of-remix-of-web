# Sentinel Build Server (Go edition)

Polls the Lovable frontend, compiles personalized Go agents for each queued
build, and uploads the resulting Windows `.exe`.

## Requirements
- Python 3.10+ with `requests` (`pip install requests`)
- Go 1.22 or newer in `PATH`
- The same `buildserver_key` configured here as in **Lovable → Admin → Build
  Server** (table `build_server_config`)

## Run
```bash
python build.py
```

`config.json` controls the frontend URL, the access key, and the GOOS/GOARCH
cross-compile target (defaults to `windows`/`amd64`).

## How it works
1. `GET /api/public/buildserver/poll` — picks up a queued build row.
2. `GET /api/public/buildserver/stub` — pulls the Go source template
   (`main.go`, `go.mod`) with `{{PLACEHOLDERS}}` for user id, relay URL,
   API base, startup name, debug flag, and feature flags.
3. Substitutes the placeholders, runs `go mod tidy` + `go build`, and uploads
   the artifact via `POST /api/public/buildserver/upload`.

The hidenhost relay (see `../hidenhost/`) handles realtime screen / WebRTC
traffic between the compiled agent and the browser control page.
