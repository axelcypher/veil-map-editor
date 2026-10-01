# sync-server

A small store for keeping your own apps in step across devices. It knows nothing about the data:
clients put bytes under a name, get them back, and the server refuses a write that does not build
on the newest revision. What an item means is up to the app (the VEIL Editor stores one project
per item).

- **Space by code:** `Authorization: Bearer <code>` opens a space. The same code on every device
  means the same space. Codes have 24–512 characters; the apps generate 32 random ones. The server
  stores only a hash of the code as folder name.
- **No silent overwrites:** every write names the revision it builds on (`If-Match`). If the item
  moved on in the meantime, the answer is `409` with the current revision, and the app decides.
- **History:** the last `SYNC_HISTORY` revisions of each item are kept.
- **Storage:** plain files in `/data`, each written to a temporary file, flushed and renamed, so a
  crash never leaves half an item.

## API

| Request | Purpose |
|---|---|
| `GET /health` | `ok` (no code needed) |
| `GET /v1/items` | all items of the space: `name`, `rev`, `size`, `sha256`, `updated` (ms), `content_type` |
| `GET /v1/items/{name}` | current data; `ETag`/`X-Revision` carry the revision. With `If-None-Match: "<rev>"` → `304` if unchanged |
| `PUT /v1/items/{name}` | new revision. `If-Match: "<rev>"` (`"0"` for a new item, `*` to overwrite). `201`/`200` with the new meta, `409` if outdated |
| `DELETE /v1/items/{name}` | removes item and history (`If-Match` as above) |
| `GET /v1/items/{name}/history` | kept revisions, newest first |
| `GET /v1/items/{name}/history/{rev}` | data of an older revision |

Item names: letters, digits, `.`, `-`, `_`, at most 128 characters.

## Configuration

| Variable | Default | |
|---|---|---|
| `SYNC_SERVER_KEY` | empty | if set, creating a **new** space needs `X-Server-Key: <key>`; existing spaces work with their code alone |
| `SYNC_MAX_ITEM_MB` | 64 | largest single upload |
| `SYNC_MAX_SPACE_MB` | 1024 | per space, history included |
| `SYNC_MAX_SPACES` | 100 | |
| `SYNC_HISTORY` | 20 | revisions kept per item |
| `SYNC_PORT` | 8080 | |
| `SYNC_DATA` | `/data` | |

Without `SYNC_SERVER_KEY` anybody who knows the address can open a space of their own; the limits
above cap what that can cost.

## Deploy (Komodo)

The image is built by `.github/workflows/build-sync-server.yml` as
`ghcr.io/axelcypher/sync-server:sha-<commit>` and `:latest`. `deploy/compose.yaml` and
`deploy/prod.env` follow the `gitops-homelab` layout: copy them to `apps/docker/sync-server/`,
set `SYNC_HOST` (and optionally `SYNC_SERVER_KEY`), and point a Komodo stack at that
folder. Traefik routes `SYNC_HOST` (TLS via the `dns-cloudflare` resolver) over the `proxy` network.
In the resource-sync TOML (`komodo/apps/<name>.toml`) set `registry_provider="ghcr.io"` and
`registry_account="axelcypher"`; without them the pull is denied on hosts whose own GHCR access
is limited. The live stack is `veilmap-sync` on `veilmap.pendzialek.net`.

## Local

```
cargo run --release            # SYNC_DATA=./data SYNC_PORT=8787 …
sync-server healthcheck        # exit code 0 when the server answers (used by the image)
```
