# Kubernetes

Single-replica deployment of the MCP server in CouchDB (LiveSync) mode. CouchDB
itself is not included — point `COUCHDB_URL` in `configmap.yaml` at yours.

## Build and push the image

The Dockerfile copies a prebuilt `dist/`, so build first:

```sh
git submodule update --init --recursive
npm ci
npm run build

REG=harbor.cloud.traunseenet.com/library/obsidian-sync-mcp
TAG=$(git rev-parse --short HEAD)
docker login harbor.cloud.traunseenet.com
docker build --platform linux/amd64 -t "$REG:$TAG" -t "$REG:latest" .
docker push "$REG:$TAG"
docker push "$REG:latest"
```

## Deploy

1. Edit `configmap.yaml` (`COUCHDB_URL`, `VAULT_NAME`, `BASE_URL`) and the
   host in `ingress.yaml` — `BASE_URL` must match the Ingress host exactly,
   because OAuth redirects are built from it.
2. Create the namespace and Secret (see `secret.example.yaml`):

   ```sh
   kubectl apply -f namespace.yaml
   kubectl -n obsidian-sync-mcp create secret generic obsidian-sync-mcp \
     --from-literal=COUCHDB_PASSWORD='...' \
     --from-literal=MCP_AUTH_TOKEN="$(openssl rand -base64 32)"
   ```

3. Pin the image you pushed and apply:

   ```sh
   cd deploy/kubernetes
   kustomize edit set image harbor.cloud.traunseenet.com/library/obsidian-sync-mcp:$TAG
   kubectl apply -k .
   ```

Connect clients to `https://<your-host>/mcp`.

## Notes

- One replica, `Recreate` strategy: the search index and OAuth sessions live in
  the process and on a single RWO volume, so two pods must never overlap.
- `/data` (PVC) holds the search index and auth tokens. Losing it forces a full
  index rebuild and signs every client out; nothing else.
- The container runs as uid 1000 with a read-only root filesystem and a
  writable `/tmp`. If a future version needs to write elsewhere, the pod will
  crash-loop with `EROFS` — set `readOnlyRootFilesystem: false` to confirm.
