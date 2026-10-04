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

## Deploy

Use the image from GitHub Container Registry (GHCR):
`ghcr.io/axelcypher/sync-server:latest`, or pin a build with the `sha-<commit>` tag.
Paths below are relative to `sync-server/`.

1. Use `deploy/compose.yaml` and `deploy/prod.env` as templates for your deployment,
   keeping both files together. Set `SYNC_IMAGE_VERSION` to the desired image tag,
   `SYNC_HOST` to your public hostname, and optionally `SYNC_SERVER_KEY` to restrict
   creation of new spaces. Supply `prod.env` as the Compose interpolation environment
   as well as the service's environment file.
2. Adapt the templates to your infrastructure. The supplied Compose file contains
   Traefik-specific routing, TLS resolver settings and other deployment labels;
   replace or remove these as appropriate for your reverse proxy. It also expects
   an existing external network named `proxy`; create that network or adjust the
   network configuration so your proxy can reach the service.
3. Pull the image and start the service with Docker Compose. Keep the `sync_data`
   volume mounted at `/data` for persistent storage. The template sets `SYNC_DATA`
   to `/data` and `SYNC_PORT` to `8080`.
4. Run behind any reverse proxy that terminates TLS with a valid certificate for
   your public hostname and forwards requests to the service over HTTP on port
   `8080`. The template publishes no host port; a proxy outside the container
   network needs an appropriate port mapping, restricted to the proxy's access.
   Check `/health` through the public HTTPS endpoint, then use that endpoint's
   base URL in the app.

## Local

```
cargo run --release            # SYNC_DATA=./data SYNC_PORT=8787 …
sync-server healthcheck        # exit code 0 when the server answers (used by the image)
```
