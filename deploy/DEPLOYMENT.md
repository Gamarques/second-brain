# Deploying Second Brain 1.0

Second Brain 1.0 is fresh-install only. Deploy it with a new PostgreSQL database
or a new explicitly named volume. The migrator refuses an unmanaged nonempty
`public` schema and there is no in-place upgrade or automatic import path.

## Production topology

The Compose deployment runs six service roles from one immutable application
image:

- `postgres`: PostgreSQL with `pgvector`;
- `migrate`: one-shot Drizzle migration gate;
- `auth`: OAuth authorization server on internal port 3001;
- `engine`: OAuth-protected MCP Streamable HTTP on `/mcp`, internal port 3000;
- `admin`: OAuth-protected React administration on `/admin`, internal port
  3002;
- `automation-worker`: private scheduled-job process with no listening port.

The application image runs as the non-root `node` user. Runtime filesystems are
read-only, `/tmp` is an in-memory filesystem, Linux capabilities are dropped,
and `no-new-privileges` is enabled. PostgreSQL and diagnostic ports bind to
loopback by default.

Put a TLS-terminating reverse proxy on the same Docker network. The included
Traefik labels route `/admin` and `/api/admin` to `admin`, route `/mcp` and its
protected-resource metadata to `engine`, and route all remaining public OAuth
paths to `auth`. The proxy must preserve the original `Host` header and set
unambiguous `X-Forwarded-Host` and `X-Forwarded-Proto` headers.

## Required configuration

Copy `.env.example` to the deployment directory as `.env`, set mode `0600`, and
provide at least:

| Variable | Meaning |
| --- | --- |
| `POSTGRES_PASSWORD` | Unique PostgreSQL password |
| `OPENROUTER_API_KEY` | Model-provider credential |
| `SECOND_BRAIN_PUBLIC_URL` | Final HTTPS origin, without a path |
| `SECOND_BRAIN_PUBLIC_HOST` | Hostname used by edge routing |
| `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY` | Canonical base64url encoding of exactly 32 random bytes |

Configure dollar-denominated spending limits, alerts, and provider quotas in
the OpenRouter dashboard. The worker has no local token-price variables and
does not claim to enforce a local USD budget.

Optional model identity:

| Variable | Default |
| --- | --- |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `OPENROUTER_EMBEDDING_MODEL` | `google/gemini-embedding-001` |
| `OPENROUTER_EMBEDDING_MODEL_REVISION` | `provider-managed` |
| `OPENROUTER_ANSWER_MODEL` | `deepseek/deepseek-v4-flash` |
| `OPENROUTER_INGESTION_MODEL` | answer model |
| `OPENROUTER_DREAMING_MODEL` | answer model |
| `OPENROUTER_VERIFICATION_MODEL` | answer model |
| `OPENROUTER_REQUEST_TIMEOUT_MS` | `30000` |
| `OPENROUTER_APP_URL` | unset |

Compose defaults `SECOND_BRAIN_WORKER_ID` to the stable
`second-brain-automation-1`. Override it with a distinct stable value for each
worker replica, using at most 200 letters, digits, `.`, `_`, `:`, or `-`.

Generate the configuration key once:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Back up the value and do not rotate the configuration key by replacing the
environment variable: stored secret overrides cannot be decrypted with a new
key. The same configuration key is passed to every model runtime so engine,
admin, and automation restarts read one consistent override snapshot.

The provider always requests zero-data-retention routing and denies provider
data collection. These are enforced policies, not environment toggles.

HTTP/OAuth controls:

| Variable | Meaning | Default |
| --- | --- | --- |
| `INVOKTA_HTTP_AUTH_MODE` | `oauth` or exclusive static `bearer` | `oauth` |
| `INVOKTA_OAUTH_ISSUER` | External OAuth issuer override | public origin |
| `INVOKTA_OAUTH_JWKS_URL` | Server-side JWKS URL | public issuer `/jwks` |
| `INVOKTA_HTTP_ALLOWED_HOSTS` | Comma-separated raw Host allowlist | safe OAuth-derived Compose values |
| `INVOKTA_HTTP_ALLOWED_ORIGINS` | Exact browser origin allowlist | unset |
| `INVOKTA_HTTP_MAX_BODY_BYTES` | MCP request body limit | 1 MiB |
| `INVOKTA_OAUTH_ALLOWED_HOSTS` | OAuth raw Host allowlist | public host plus internal diagnostics |
| `INVOKTA_HTTP_BEARER_TOKEN` | Static token, at least 32 characters | optional alongside OAuth; required in exclusive bearer mode |
| `INVOKTA_HTTP_PRINCIPAL_ID` | Existing active account UUID | optional alongside OAuth; required in exclusive bearer mode |

An empty or malformed required value aborts startup. Setting one static bearer
variable without the other also aborts startup. Static bearer attributes
do not grant a role; the active account and its current `accounts.role` value are
still checked in PostgreSQL for every invocation.

## First deployment

Provision the directory and starter environment on a VPS:

```sh
scp deploy/vps-setup.sh <user>@<vps>:/tmp/
ssh <user>@<vps> bash /tmp/vps-setup.sh
```

Edit `/opt/second-brain/.env`, configure DNS/TLS, and deploy either through the
local build mode or the GitHub workflow.

For a local source upload on the VPS:

```sh
cd /opt/second-brain
SECOND_BRAIN_DEPLOY_MODE=build deploy/deploy.sh
```

Build mode waits for the OAuth service. The engine, admin service, and worker
stay down until owner bootstrap creates embedding spaces. After auth is
healthy, run bootstrap from an interactive trusted terminal:

```sh
cd /opt/second-brain
docker compose run --rm auth node dist/services/auth/bootstrap-account.js
```

Bootstrap requires valid database and OpenRouter configuration. In one
transaction it creates the first UUID account with the `owner` role, the
singleton automation-settings row with UTC as its initial timezone, and active
embedding spaces for memories, decisions, and knowledge chunks. An exact
credential/provider replay returns the same IDs; a mismatch or integrity
failure fails closed and creates nothing.

Bootstrap requires stdin/stdout TTY support and hidden password confirmation.
It fails with `Account bootstrap requires an interactive terminal.` otherwise.
Never save the account password in `.env`, Compose, deployment arguments, or
logs.

Restart the model runtimes after owner bootstrap, then open the first-access
panel:

```sh
SECOND_BRAIN_DEPLOY_MODE=wait-engine bash deploy/deploy.sh
```

Visit `${SECOND_BRAIN_PUBLIC_URL}/admin` and sign in through the existing OAuth
server with an active `admin` or `owner` account. The panel uses Authorization
Code with S256 PKCE and creates no separate identity or password. It can enable
and enqueue dreaming, inspect workers and jobs, manage memories and knowledge,
stage allowlisted model configuration, and read the redacted audit log. Staged
configuration takes effect only after the affected runtime services restart.

### Bootstrap without a terminal

An automated deployment has no TTY. It uses a second entry point that reads the
same credentials from standard input, so the password still never reaches an
environment variable, a command line, `ps`, or the server's shell history:

```sh
cd /opt/second-brain
printf '%s\n%s\n' "$EMAIL" "$PASSWORD" \
  | docker compose run --rm -T auth node dist/services/auth/bootstrap-noninteractive.js
```

Note that the shell above still exposes the password to the local process
table; a deployment tool should instead write the two lines directly to the
command's standard input over its own transport. It refuses a TTY, so it cannot
be used interactively by mistake, and it takes the email from the first line
and the password from the second — verbatim, without trimming.

It prints `OAuth owner created: <email>` on success. When the account already
exists it writes `The OAuth owner account already exists.` to stderr and exits
`0`, so re-running a deployment is safe.

## Drizzle migration gate

The image contains an ordered journal of bundled migrations under `drizzle/`.
The `0000` baseline creates the initial single-brain v1 schema directly; later
entries add features and are not an upgrade or data-conversion path from a
pre-v1 database. `migrate` runs before `auth`, `engine`, `admin`, or
`automation-worker` and:

1. checks that an unmanaged `public` schema is empty;
2. takes a session advisory lock on one checked-out connection;
3. verifies the stored migration order and checksums;
4. applies each pending migration in its own transaction;
5. records the matching hash and timestamp.

Runtime services call the migration-current assertion and never auto-migrate.
An unknown, missing, reordered, or edited migration is a deployment failure.
Do not repair it by editing the ledger or SQL. Before the first deployment,
discard any old database or volume instead of attempting to convert it. After
the baseline has been applied, restore a known database/image pair or ship a new
generated migration for later schema changes.

The baseline requires PostgreSQL 15+ and installs `pgcrypto`, `vector`, and
`btree_gist`. The Compose image is pinned to PostgreSQL 18 with pgvector 0.8.2.

## Health and graceful shutdown

The image healthcheck opens one bounded loopback TCP connection to the port in
`INVOKTA_HTTP_PORT`. It proves that `engine`, `auth`, or `admin` is listening
without holding or printing a credential. The deployment gate waits for all
three services to become healthy. The separate `deploy/healthcheck.mjs` probe
can validate an MCP initialize result or a correct Bearer challenge from an
engine endpoint.

The automation worker has no public port; deployment checks that its process
remains running, while durable database heartbeats and sanitized logs provide
operational liveness.

`engine`, `auth`, `admin`, and `automation-worker` receive `SIGTERM`. HTTP
serving stops and tracked invocations are aborted before the database pool
closes. The worker aborts in-flight work and closes resources. Its 300-second
leases, fencing tokens, receipts, and bounded retries make crash recovery safe.

Useful diagnostics:

```sh
docker compose ps
docker compose logs --tail=100 migrate auth engine admin automation-worker
```

Never log tokens, passwords, model payloads, source excerpts, or report
evidence. Worker failures use stable sanitized codes and bounded metadata.

## OAuth verification

The public origin serves authorization-server discovery, protected-resource
metadata, JWKS, dynamic client registration, browser login/consent, token,
refresh, revocation, the MCP endpoint, and the administration panel. MCP clients
use Authorization Code with S256 PKCE and the `mcp:tools` scope, or a configured
static bearer token on the same `/mcp` URL. The built-in browser administration
client uses Authorization Code with S256 PKCE and a bearer token restricted to
the `/api/admin` resource and `admin:panel` scope.

The container liveness check does not complete a browser login. Verify public
discovery separately, then use an interactive MCP client to test login,
consent, token exchange, tool discovery, and invocation.

This repository validates the generic MCP/OAuth contract. Treat named client
releases as unsupported until their current discovery and invocation flow has
its own smoke test.

## CI/CD

The GitHub workflow runs `npm run check` and a separate PostgreSQL 15+pgvector
integration job before publishing. The integration job uses an isolated test
database and never the deployment volume.

Registry deployment requires:

| Secret | Meaning |
| --- | --- |
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USER` | SSH account |
| `VPS_SSH_KEY` | OpenSSH private deploy key |
| `VPS_PORT` | Optional non-default SSH port |

The deploy workflow copies matching Compose/deploy artifacts, pulls one
commit-tagged image, starts services, and fails if migration, OAuth, engine,
admin, or worker startup is unhealthy. The registry token is passed on stdin
and removed from the VPS session after the pull. If `/opt/second-brain/.env`
predates `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY`, `deploy.sh` generates that
value once and leaves an existing key unchanged.

### The image build is project-owned, not toolkit-generated

`Dockerfile`, `.dockerignore`, and this file are maintained by hand. Do not run
`invokta-deploy package`: it regenerates all four files it owns, and its
`Dockerfile` is incompatible with this deployment. The generated image omits
`drizzle/`, which `dist/database/migrate.js` resolves at runtime for the
migration ledger; omits the built React administration assets and ports 3001
and 3002; and points `HEALTHCHECK` at `deploy/healthcheck.mjs` instead of
the `dist/healthcheck.js` this image actually ships. The toolkit refuses to
overwrite these files because they lack its generated-file marker, which is the
intended outcome — leave the marker off. `npm run deploy:package` therefore
builds and verifies artifacts only, and `invokta-deploy probe` remains available
for liveness checks against a running deployment.

## Brain Pack archives

Brain Packs need nothing new to mount. Uploaded and exported `.brainpack`
archives live in PostgreSQL (`knowledge_pack_artifacts`, as `bytea`) next to
the run tables, so the database backup already covers them and a container
keeps no archive on disk. Uploads expire after 24 hours and exports after seven
days; the automation worker deletes expired rows, so it must run for the table
to stay bounded.

The upload route accepts up to 64 MiB in one request body. The admin service
enforces that limit itself, and `INVOKTA_HTTP_MAX_BODY_BYTES` does not apply to
it because it governs the MCP endpoint only. The reverse proxy in front of the
admin service must let a body of that size through on
`POST /api/admin/packs/uploads`. Traefik imposes no body limit by default. The
nginx configuration shipped for a development installation
(`deploy/local-nginx.conf`) keeps its 1 MiB default and carves out
`/api/admin/packs/` with `client_max_body_size 64m;`; keep that exception when
adapting the file for another proxy.

## Backups, rollback, and privacy

Back up PostgreSQL as one security boundary because brain content, OAuth
artifacts, cookie/signing keys, job state, evidence, Brain Pack archives, and
reports live together. Test full restore, not content-only restore.

Application rollback must keep the image and its migration history compatible
with the database. Reusing an earlier image after a newer migration is not
automatically safe. Restore the matching database backup when schema
compatibility is not proven.

Account erasure is an internal persistence transaction, not an MCP operation.
Production must wrap it in a separately authenticated, human-controlled
administrative workflow. Coordinate live erasure with backup expiry because
backups retain older data until their retention window ends.
When the last account is erased, the bootstrap claim is released so an operator
can create a replacement owner without deleting deployment-owned content,
settings, or embedding spaces.

Entity deletes are deliberately narrower. Task/reminder deletion covers the
canonical record plus owned versions, links, and delivery state; memory deletion
covers its lineage in memory retrieval/history. Independent ingestion source
excerpts, dreaming evidence/reports, and handoff prose remain governed by the
retention or erasure flow that owns each copy.

Changing embedding provider, model, revision, recipe, dimensions, or metric
requires an audited re-embedding lifecycle: prepare a new space, rebuild all
vectors, verify coverage/retrieval, promote atomically, and retire the prior
space. Never compare vectors across spaces.
