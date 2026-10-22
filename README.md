# Second Brain

Second Brain is a shared context layer for AI clients. It stores durable
memories, decisions and their rationale, tasks, reminders, projects, people,
goals, priorities, activities, and versioned knowledge. Public MCP HTTP and
trusted internal direct invocation use the same `engine.invoke` boundary.

Version 1.0 is a clean, fresh-install-only release. It has one Drizzle schema,
explicit accounts and roles, and no compatibility data path for earlier
databases or capability contracts.

New here? Start with
[Getting started (English)](docs/getting-started.en.md) or
[Primeiros passos (Português)](docs/getting-started.pt-BR.md).
Release operators can also read
[Release artifacts](docs/release-artifacts.en.md).

## Monorepo layout

This repository is an npm-workspaces monorepo with one lockfile:

- `apps/engine` is a framework-shaped, independently runnable Invokta
  application. It owns the conventional engine export, public capabilities,
  direct and MCP HTTP entrypoints, domain contracts, PostgreSQL and provider
  adapters, migrations, engine tests, and deployment configuration;
- `apps/server` owns the OAuth HTTP service, admin API, automation worker, and
  their service-specific persistence and tests;
- `apps/admin` owns the React/Vite administration application;
- the repository root owns only cross-workspace orchestration, deployment,
  continuous integration, and shared TypeScript policy.

Run commands from the repository root. Root scripts delegate to the owning
workspace; application dependencies must be declared in that application's
`package.json`. The root may declare only tooling shared across workspaces.

## What the product guarantees

- The deployment serves exactly one brain, so no request names or selects one.
  The account's current database role, not a token claim, determines the
  allowed access.
- Every write records actor provenance. An OAuth client ID identifies the
  calling client, but never grants access.
- Semantic retrieval compares vectors only inside one active, compatible
  embedding space.
- Historical capabilities expose versions and coverage gaps instead of
  pretending to reconstruct data that was never recorded.
- Model output is untrusted. Conversation ingestion is proposed, reviewed,
  and committed through separate durable steps.
- Daily dreaming is an internal scheduled job. No public MCP client can trigger
  it or choose its policy through MCP.
- The only public MCP dreaming capability reads a stored, bounded report with
  cited insights and memory changes.

The server makes common context available to every compatible client. It
cannot guarantee that a third-party model will decide to call a tool. Use
`context_get` at session start, or enforce that call in a controlled harness,
when context loading must be mandatory.

## Capability catalog

The v1 engine exposes 64 capabilities:

| Domain | Capability IDs |
| --- | --- |
| Task lists | `task_lists_create`, `task_lists_list` |
| Tasks | `tasks_create`, `tasks_list`, `tasks_update`, `tasks_delete`, `tasks_history_list`, `task_relations_create` |
| Memories | `memories_create`, `memories_update`, `memories_search`, `memories_list`, `memories_delete` |
| Reminders | `reminders_create`, `reminders_list`, `reminders_update`, `reminders_delete`, `reminders_history_list` |
| Knowledge | `knowledge_bases_create`, `knowledge_bases_list`, `knowledge_documents_list`, `knowledge_documents_get`, `knowledge_document_revisions_create`, `knowledge_document_revisions_list`, `knowledge_ask` |
| Brain Packs | `knowledge_packs_export`, `knowledge_packs_export_get`, `knowledge_packs_import`, `knowledge_packs_import_get`, `knowledge_packs_import_review`, `knowledge_packs_import_publish`, `knowledge_packs_runs_list`, `knowledge_packs_runs_cancel`, `knowledge_packs_runs_retry` |
| Projects | `projects_create`, `projects_list`, `projects_update` |
| People | `people_create`, `people_list`, `people_update` |
| Decisions | `decisions_create`, `decisions_list`, `decisions_revoke` |
| Goals | `goals_create`, `goals_update`, `goals_list`, `goals_history` |
| Strategic priorities | `priorities_create`, `priorities_update`, `priorities_list` |
| Activities | `activities_record`, `activities_list`, `activities_retract`, `activities_summary` |
| Reasoning | `brain_ask`, `brain_search` |
| Reviewed ingestion | `ingestion_propose`, `ingestion_review`, `ingestion_commit`, `ingestion_status` |
| Client continuity | `context_get`, `handoffs_create`, `handoffs_list` |
| Dreaming | `dreaming_report_get` |

All capabilities require an authenticated account and operate on the
deployment's single brain. No input identifies a brain: the account's role is
resolved from the authenticated principal alone, and it is revalidated on each
invocation. Reads require at least `viewer`, ordinary writes require at least
`editor`, and privacy deletion requires an administrative role. Inspect the
exact input, output, access, timeout, and annotation contract through MCP tool
discovery.

`projectId` is optional wherever it appears. Omit it to record general
information that belongs to no project, and pass an explicit `null` on an
update to detach an existing record from its project. A strategic priority plan
without a `projectId` is the general plan.

Priority plan creation and updates retry a transaction aborted by a PostgreSQL
deadlock, up to three total attempts within the invocation deadline. Each
attempt rechecks access, overlap, and idempotency; rolled-back attempts leave no
partial plan history. Other database errors retain their existing behavior.

## Brain Packs

A Brain Pack is a portable archive of knowledge bases and documents that one
brain publishes and another imports. The format, its limits, and the integrity
rules are specified in [docs/brain-pack-format.md](docs/brain-pack-format.md).

- `knowledge_packs_export` freezes the selected knowledge in one read
  transaction, encodes it, and stores the archive for seven days. Exact text
  is labelled `canonical`; text stitched back from chunks is labelled
  `reconstructed`. Re-exporting an owned pack advances its revision and keeps
  every item key stable.
- `knowledge_packs_import` validates an uploaded archive synchronously and
  classifies every document against what this brain imported before: `new`,
  `updated`, `unchanged`, `conflicting`, or `invalid`. Nothing is written until
  `knowledge_packs_import_review` freezes the destinations and per-item
  decisions and `knowledge_packs_import_publish` presents the matching review
  digest. The automation worker then embeds the chunks in batches and publishes
  documents, revisions, embeddings, origin links, and mappings in one
  transaction. Imports never delete local documents; a document edited locally
  since its last import is reported as conflicting rather than overwritten.
- `knowledge_documents_get`, `knowledge_document_revisions_list`, and the
  citations of `knowledge_ask` carry the publisher, pack, revision, and authors
  of any revision a pack published.

All nine capabilities require an administrative role: `admin` or `owner`, and
`owner` satisfies `admin`. The browser console reaches them through the admin
API allowlist as `knowledge-packs-*` operations, so a member never selects a
capability ID from the browser.

Limits and retention in version 1:

- A compressed archive is at most 64 MiB and expands to at most 256 MiB, with
  up to 2,000 entries. Larger packs are refused before validation.
- A synchronous export carries at most 200 documents; the archive is kept for
  seven days.
- An uploaded archive is kept for 24 hours; an import that does not reach
  publication in that window has to be uploaded again.
- One import may be active per account, and two per deployment.

An import awaiting review still counts toward the active limit. Finish or cancel
it from the Brain Pack history before starting another. Admin capability requests
report pack size or active import limits as HTTP 409 with `PACK_LIMIT_EXCEEDED`.

Archive bytes move over two dedicated admin routes rather than the JSON
capability channel:

- `POST /api/admin/packs/uploads` accepts the raw `.brainpack` bytes as
  `application/octet-stream` (optionally with `X-Content-Sha256` to declare
  the digest) and answers with the artifact reference that
  `knowledge_packs_import` takes.
- `GET /api/admin/packs/exports/{runId}/download` streams the archive of a
  completed export run to its owner or to an administrator, as an attachment
  named after the pack ID and revision, and answers 410 once it expired.

Publication needs the automation worker: `knowledge_packs_import_publish`
queues a `brain_pack_import` job, and the worker embeds the chunks and commits
the run. The same worker sweeps expired upload and export archives on a bounded
interval. Without a running worker a published import stays in `indexing`.

## Reviewed conversation ingestion

Conversation capture is a durable four-step protocol:

1. `ingestion_propose` stores the source and model-generated candidates
   with exact source spans. It does not create brain records.
2. `ingestion_review` accepts or rejects the persisted candidates. A caller
   cannot replace the model payload during review.
3. `ingestion_commit` applies the reviewed set with idempotent receipts.
4. `ingestion_status` recovers the run, proposals, review, and receipts
   after retries or a lost response.

Idempotency keys are bound to canonical request digests. A reused key with
different content fails rather than silently changing meaning. Model confidence
is evidence for review, not authorization to write.

## Grounded retrieval and history

`brain_search` is the primary lookup for who/what/about questions. It searches
memories, every knowledge base, people, projects, decisions, goals, and tasks
in one call and always returns the live knowledge-base catalog (name plus what
each base covers), a people index, and suggested bases when the query looks
like a person or topic lookup. `brain_ask` then reasons over bounded, cited
evidence from memories, decisions, tasks, reminders, goals, priorities, and
recorded activities. It distinguishes stored facts from inference, reports
temporal coverage, and abstains when the available evidence is insufficient.
`brain_ask` does not search knowledge documents; use `brain_search` for that.

Memories and decisions retain immutable lineage. Updates create a new version
with optimistic version and content-hash checks. Exact normalized replay may be
deduplicated, but semantic similarity alone never silently supersedes a memory.
Task and reminder history is also versioned. Activity summaries describe only
explicitly recorded intervals; they do not infer time spent from edit counts.

Reminders are durable brain records. Version 1.0 does not send email, push,
calendar, or webhook notifications; reminder delivery remains a separate
operator/provider feature and is not part of dreaming.

Knowledge documents have stable identities and immutable revisions.
`knowledge_document_revisions_create` uses an expected revision for optimistic
concurrency and may attach tags, a project, and people so documents, memories,
and the people index can navigate the same work. `knowledge_ask` returns only
a grounded answer with the retrieved citations that support it.

## Daily dreaming

Dreaming is a separate automation worker, not a public MCP capability. The
private administration engine can enqueue a run. Once enabled by its trusted
settings surface, the worker processes the last completed civil day in the
brain's IANA timezone. A run uses the day's bounded activity and entity
evidence to:

- write a cited summary and up to ten bounded insights;
- propose durable memory creation;
- propose a new version of an existing memory when newer evidence changes the
  same fact.

Insight kinds are `observation`, `contradiction`, `open_loop`, and
`pattern_hypothesis`. Insights remain report content and do not become memories
automatically. Pattern hypotheses require multiple original episodes and are
labeled as hypotheses, not facts.

Automatic memory creation is limited to deterministic, extractive facts backed
by exact cited source text. Semantic memory updates require a separate verifier
and optimistic target checks. Dreaming never changes tasks, reminders,
decisions, people, projects, goals, priorities, knowledge documents, roles, or
permissions, and never deletes anything.

The administration panel includes a monthly calendar with every job attempt and
stored report link. Administrators can reprocess a terminal failed job after
fixing its configuration. A replay is a new durable job, deduplicated per failed
attempt, and always runs in preview mode. It preserves the original run's time
zone/window and leaves existing history and effects intact. A failed replay can
itself be retried; active or completed jobs cannot be reset through this action.

`dreaming_report_get` reads the latest report, one local date, or one run ID.
It never calls a model, starts or wakes a job, or changes run state. A missing
report returns `report: null`. Reports include summary, cited insights, created
or updated memories, skipped proposals, and coverage warnings.

Dreaming is disabled by default and starts in `preview` mode. Version 1.0 does
not expose automation settings through MCP; provisioning or changing those
settings is an operator-controlled action.

Dollar-denominated spending controls are external. Configure account/project
limits and alerts in the OpenRouter dashboard. The worker does not accept local
token-price variables or claim to enforce a local USD budget.

## Requirements

- Node.js 22.20 or newer
- PostgreSQL 15 or newer with `vector`, `pgcrypto`, and `btree_gist` available
- An OpenRouter API key

The Compose stack uses the pinned `pgvector/pgvector:0.8.2-pg18-trixie` image.
The real-database test harness also validates the schema against an isolated
PostgreSQL service.

OpenRouter is the default model gateway. The default embedding model is
`google/gemini-embedding-001`, requested with 1,536 dimensions, and the default
answer model is `deepseek/deepseek-v4-flash`. Ingestion, dreaming, and dreaming
verification default to the answer model unless separately configured.

## Fresh installation with Docker Compose

Do not attach a database created by an earlier release. Version 1.0 has no
in-place upgrade, dual-write phase, or automatic import path. Use a new database
or a new, explicitly named volume and import only data that has been reviewed
for the v1 contracts.

Create and edit the environment file:

```sh
cp .env.example .env
```

At minimum, replace the database password, OpenRouter key, public URL and
hostname, and configuration-encryption key. Then start the stack:

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f migrate auth engine admin automation-worker
```

Compose waits for PostgreSQL and applies the bundled Drizzle migrations in
journal order before starting OAuth, MCP HTTP, the administration panel, and
the automation worker. The `0000` baseline creates the initial v1 schema
directly; later bundled migrations add features without providing an upgrade
path from the pre-v1 data model. Create the initial owner account:

```sh
docker compose run --rm auth node dist/services/auth/bootstrap-account.js
```

The bootstrap transaction creates a UUID account holding the `owner` role, the
automation settings row with UTC as its initial timezone, and active memory,
decision, and knowledge-chunk embedding spaces bound to the configured provider
identity. Bootstrap therefore requires valid OpenRouter configuration. An exact
replay verifies and returns the same IDs; any email, password,
provider-identity, or persisted-state mismatch fails closed and never creates a
second account. Version 1.0 does not expose an additional-account provisioning
or role-management surface. Bootstrap is interactive-only and fails with
`Account bootstrap requires an interactive terminal.` without stdin/stdout TTY
support. Never store its password in `.env`, Compose, arguments, or logs.

After owner bootstrap, restart the model runtimes and open the administration
panel:

```sh
SECOND_BRAIN_DEPLOY_MODE=wait-engine bash deploy/deploy.sh
```

Visit `${SECOND_BRAIN_PUBLIC_URL}/admin` and sign in through the existing OAuth
server with an active `admin` or `owner` account. The panel uses Authorization
Code with S256 PKCE and does not create a separate identity or password. It
manages dreaming, allowlisted runtime model configuration, memories, knowledge,
the read-only visual brain map (on its own page), worker/job status, and the
redacted audit log.

**Review learning** pages pending ingestion runs and finished Dreaming preview
suggestions, with a separate history. Ingestion requires an explicit decision
for every proposal, then a separate atomic commit. Dreaming shows the current
memory, proposed content and cited evidence before confirmation. Approval
rechecks authorization, unredacted evidence and target versions, independently
verifies updates, and records one durable decision and memory write. Rejection
uses no model. Original preview reports remain historical; approved events are
excluded from future Dreaming input to prevent feedback loops. These review
controls are private administrative capabilities; public MCP contracts are
unchanged.

To stop processes without deleting database data:

```sh
docker compose down
```

The services handle `SIGINT` and `SIGTERM`. MCP/OAuth runtime shutdown closes
the database pool; the automation worker aborts in-flight work, releases its
process resources, and lets durable leases and receipts make retries safe.

## Browser workspace

**Skills & prompts** (`/admin/agent-resources`) offers three English Markdown
downloads with previews and copy buttons: a reusable Second Brain MCP skill,
a standalone MCP instructions prompt, and an interactive knowledge calibration
prompt. The page explains how to use each file and is linked from connection
setup and completed Brain Pack imports. The calibration prompt distinguishes
imported reference material from demonstrated knowledge, assesses the user's
level, and asks them to review a dated learning profile before the connected
agent saves it through the existing memory capabilities. All three materials
instruct the agent to respond in the user's language. Downloading or copying
them does not invoke the MCP or change brain records.

**Home** opens on a question box. **Ask your brain** searches current
memories, documents, people, projects, decisions, goals and tasks together,
from the home page or from the docked panel (Ctrl/⌘+J) on any page, which
scopes itself to the open project or document folder. It retrieves at most 20 sources within a
12,000-character budget and validates numbered citations before returning an
answer in English, Portuguese or Spanish. Document citations identify the
stored revision. Missing evidence is explicit; the existing temporal
`brain_ask` MCP contract remains unchanged. Browser cancellation propagates to
the engine and model requests. Search and answers may incur AI costs.

**Projects** combines exact section counts with separately paginated tasks,
goals, current decisions and memories, related people, and documents. People
are linked directly or through project records. Task completion and reopening
use optimistic versions. Pages load on demand instead of shipping every route
in the initial JavaScript bundle.

Below the question box, **Home** reads stored data without another AI call:
overdue work and the next 24 hours of deadlines, health checks that need a
look, the latest nightly recap, and unresolved questions from up to 30 reports
generated in the last 30 days.
Coverage limits are visible. A confirmed action creates one task or reminder
per insight and action kind, or marks the insight reviewed. Evidence digests,
redaction checks, authorization and durable receipts protect those writes;
finishing linked work removes the question from the home. Marking reviewed
does not change existing task or reminder state. A reminder needs a future
schedule; its delivery is configured separately.

## Database and Drizzle migrations

Drizzle schema modules under `apps/engine/src/database/schema/` are the source of truth for
the generated relational schema. The SQL and migration journal live under
`apps/engine/drizzle/`. The initial baseline also owns PostgreSQL extensions and integrity
objects that Drizzle does not model: deferred cyclic foreign keys, exclusion
constraints, and validation functions and triggers.

```sh
npm run db:generate
npm run db:migrate
```

`db:generate` is a development command for deliberate schema changes. Version
1.0 starts with the `0000` single-brain baseline and records later additive
migrations in the same journal. Do not recreate or append an old multi-brain
baseline before it.
`db:migrate` takes a PostgreSQL advisory lock on one checked-out connection,
refuses an unmanaged nonempty `public` schema, verifies the stored migration
order and checksums, and applies each pending migration transactionally. A
missing, reordered, or edited applied migration fails closed. Runtime processes
verify that migrations are current but never migrate automatically. Once the
initial baseline has been deployed, never edit or regenerate it; generate a new
migration for later schema changes.

## Local development

The root development command starts an isolated Docker Compose project with
PostgreSQL, migrations, OAuth, MCP HTTP, the administration panel, the
automation worker, and a loopback reverse proxy:

```sh
npm install
npm run dev
```

The command reads the existing `.env` for the OpenRouter configuration and
creates a private, ignored `.env.development` containing random local database
and encryption credentials. It does not reuse the production database URL,
ports, Compose project, or PostgreSQL volume from `.env`.

For a new local database, create the initial owner interactively once, then
open <http://127.0.0.1:8080/admin/>:

```sh
npm run dev:bootstrap
```

The bootstrap command waits for PostgreSQL, migrations, and OAuth, creates or
verifies the owner, and then waits for the complete stack. The password is read
only from the interactive terminal and is never stored in an environment file,
argument, or log. Later sessions need only `npm run dev`.

Useful lifecycle commands are:

```sh
npm run dev:ps
npm run dev:logs
npm run dev:down
npm run check
```

To stress-test the brain map locally without writing fixture records to the
database, open
<http://127.0.0.1:8080/admin/brain-map?mock=large>. This explicit loopback-only
mode renders a deterministic graph with 360 nodes and 544 relationships. Remove
the query parameter to return to the persisted brain data.

Owners can stage allowlisted runtime configuration in the administration panel
and use **Restart services** when the panel reports that a restart is required.
The request is durable and audited; the engine, administration server, and
automation worker exit gracefully and Docker Compose restarts them with the new
configuration. This requires a supervisor with a restart policy, which the
included Compose deployment provides.

The **Test and activate your AI** assistant resolves saved models (including server
fallbacks), lists OpenRouter ZDR endpoints with structured-output support, and
lets owners run a small paid synthetic probe with the saved or draft API key.
Testing never saves configuration. After saving and applying changes, compare
each service's observed revision; a stale or missing heartbeat is not proof of
activation. The catalog is advisory and the probe validates routing only at the
time of the request.

**AI consumption** records request metadata across embeddings, answers,
ingestion, Dreaming, verification, and diagnostics. It provides bounded period
and feature filters, model search, token/cost coverage, latency and sanitized
failure categories. Costs are provider-reported OpenRouter credits, never
inferred for missing records or backfilled. Tracking is best effort (a database
outage must not fail model work), stores no prompts/responses/keys, and reports
HTTP request outcomes rather than downstream content validation. An optional
30-day spending notice is local to this browser and does not stop requests;
enforce spending limits at OpenRouter.

Docker Desktop must be running. Under WSL, Docker Desktop integration must be
enabled for the distribution that contains this repository.

Trusted internal direct invocation requires an existing account UUID through
`SECOND_BRAIN_ACCOUNT_ID`. Public clients use OAuth-protected MCP HTTP. Most v1
writes require an `idempotencyKey`, and versioned updates also require an
expected version or content hash.

Run the isolated real-PostgreSQL suite with:

```sh
npm run test:postgres
```

The runner starts its own isolated Docker service or uses
`TEST_DATABASE_ADMIN_URL` to create isolated test databases. It fails closed
when neither is available and must never point at a production database or the
production Compose volume.

## Configuration

| Name | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Direct execution | PostgreSQL connection string; takes precedence over discrete `PG*` settings |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Alternative | Discrete PostgreSQL settings; Compose uses them internally |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Compose | PostgreSQL container settings |
| `TEST_DATABASE_ADMIN_URL` | PostgreSQL tests | Optional administrative URL used only to create/drop isolated test databases when Docker is unavailable |
| `OPENROUTER_API_KEY` | Semantic features | OpenRouter credential |
| `OPENROUTER_BASE_URL` | No | Defaults to `https://openrouter.ai/api/v1` |
| `OPENROUTER_EMBEDDING_MODEL` | No | Embedding model identity |
| `OPENROUTER_EMBEDDING_MODEL_REVISION` | No | Immutable embedding model revision identity |
| `OPENROUTER_ANSWER_MODEL` | No | Grounded answer model |
| `OPENROUTER_INGESTION_MODEL` | No | Reviewed-ingestion proposal model |
| `OPENROUTER_DREAMING_MODEL` | No | Daily dreaming proposal model |
| `OPENROUTER_VERIFICATION_MODEL` | No | Independent semantic-update verifier |
| `OPENROUTER_REQUEST_TIMEOUT_MS` | No | Positive per-request provider timeout in milliseconds; defaults to 30,000 |
| `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY` | Runtime | Canonical base64url encoding of exactly 32 bytes; encrypts stored allowlisted configuration and must remain stable |
| `SECOND_BRAIN_WORKER_ID` | No | Stable worker ID using letters, digits, `.`, `_`, `:`, or `-`; Compose defaults to `second-brain-automation-1` |
| `OPENROUTER_APP_URL` | No | Optional request attribution URL |
| `SECOND_BRAIN_PUBLIC_URL` | OAuth/MCP HTTP | Public HTTPS origin, with no path |
| `SECOND_BRAIN_PUBLIC_HOST` | Compose edge | Hostname used by Traefik router rules |
| `SECOND_BRAIN_ACCOUNT_ID` | Internal direct invocation | Existing active account UUID for the trusted development boundary |
| `INVOKTA_HTTP_AUTH_MODE` | No | Defaults to `oauth`; `bearer` is exclusive static-token mode |
| `INVOKTA_OAUTH_ISSUER` | No | External issuer override |
| `INVOKTA_OAUTH_JWKS_URL` | No | Server-side signing-key URL |
| `INVOKTA_HTTP_BEARER_TOKEN` | Optional | Shared secret with at least 32 characters; accepted alongside OAuth when both bearer variables are set |
| `INVOKTA_HTTP_PRINCIPAL_ID` | Optional | Existing active account UUID bound to the static token |
| `INVOKTA_HTTP_ALLOWED_HOSTS` | Non-loopback HTTP | Accepted raw `Host` values |
| `INVOKTA_HTTP_ALLOWED_ORIGINS` | Browser clients | Accepted browser origins |
| `INVOKTA_HTTP_MAX_BODY_BYTES` | No | MCP HTTP request limit; defaults to 1 MiB |
| `SECOND_BRAIN_BIND_ADDRESS` | Compose | Diagnostic bind address; defaults to `127.0.0.1` |
| `SECOND_BRAIN_HTTP_PORT` | Compose | Published MCP HTTP diagnostic port; defaults to `3000` |
| `SECOND_BRAIN_OAUTH_PORT` | Compose | Published OAuth diagnostic port; defaults to `3001` |
| `SECOND_BRAIN_ADMIN_PORT` | Compose | Published admin diagnostic port; defaults to `3002` |

Exact runtime model-variable wiring is validated at startup. Keep `.env`
private; the repository commits only `.env.example`.

## Embedding-space lifecycle

Each semantic entity type has an immutable embedding-space identity: provider,
model, model revision, recipe version, dimensions, and metric. Startup
and queries fail closed when the active space is missing or incompatible.

Changing a model name, revision, recipe, dimensions, or metric is a data
migration, not a configuration-only deploy. Create a `preparing` space,
re-embed every source record into it, verify coverage and retrieval quality,
then promote it atomically and retire the previous space. Version 1.0 does not
provide an MCP re-embedding capability; run this as audited operator
maintenance. Never compare vectors across spaces or relabel old vectors as if
they came from a new model.

## Authentication, privacy, and erasure

MCP HTTP uses OAuth by default and remains fail closed if public URL, token
signature, issuer, audience, subject, scope, or the resolved account is
invalid. The built-in authorization server supports Authorization Code with
S256 PKCE, discovery, dynamic client registration, rotating refresh tokens,
consent, and revocation. A configured static bearer token is accepted on the
same MCP endpoint without disabling OAuth; exclusive `bearer` mode is opt-in
and turns OAuth off. The static token must reference an existing active
account UUID; bearer attributes do not grant a role.

Model processing is remote. The engine sends embedding inputs, reviewed
conversation sources, retrieved evidence, and bounded dreaming snapshots to
OpenRouter and upstream providers. It requests zero-data-retention routing and
denies provider data collection by default. Those controls do not make
processing local and do not replace an operator privacy review.

Account erasure is intentionally not an MCP capability. The
internal persistence transaction pseudonymizes account and client attribution,
purges OAuth artifacts, and deletes the account row. Brain content belongs to
the deployment rather than to an account, so it survives erasure with that
account's attribution removed. A deployment must expose that transaction only
through a separately authenticated, human-controlled administrative workflow
before promising self-service deletion.

If erasure removes the deployment's last account, it also releases the
one-time bootstrap claim. An operator can then run bootstrap again to create a
replacement owner; deployment-owned content, settings, and embedding spaces are
preserved.

Back up PostgreSQL as one security boundary: it contains brain content and
OAuth keys. Erasure, retention, and backup expiry must be coordinated; deleting
the live row does not erase an older backup until that backup expires.

Entity deletion is narrower than account erasure. Deleting a task or reminder
purges that canonical entity plus its owned versions, links, and delivery state;
deleting a memory purges that memory lineage from memory retrieval and history.
Independent ingestion source excerpts, dreaming evidence/reports, and handoff
prose are not globally searched and erased by those operations. Remove them
through the retention or erasure flow that owns the independent copy.

## MCP HTTP and client continuity

The production endpoint is `${SECOND_BRAIN_PUBLIC_URL}/mcp`. An OAuth-capable
MCP client can discover protected-resource and authorization-server metadata,
register dynamically, complete PKCE login and consent, discover the capability
catalog, and invoke tools.

This repository verifies the generic MCP/OAuth contract. It does not claim
certification for a named ChatGPT, Claude, Cursor, or Codex release. Client UIs
and tool-selection behavior change independently. For portable continuity,
have a client call `context_get` with a purpose at session start and use
`handoffs_create`/`handoffs_list` when moving work between clients.

## VPS and CI/CD deployment

The production image runs as the unprivileged `node` user. Compose uses
read-only filesystems, drops Linux capabilities, checks health, rotates logs,
and binds PostgreSQL and diagnostic service ports to loopback by default. Do
not publish PostgreSQL to the internet.

The included Traefik labels route `/admin` and `/api/admin` to the
administration service, `/mcp` and protected-resource metadata to the engine,
and OAuth routes to the authorization service. The edge must share a Docker
network with those services and terminate TLS for the configured public
hostname.

The optional GitHub Actions deployment builds the image only after
`npm run check`, pushes a commit-tagged image, copies the deployment artifacts,
starts the stack, and waits for engine, OAuth, and admin health. The automation
worker has no public port; its liveness is visible through the admin panel,
sanitized logs, and database heartbeats.

For detailed operator steps, see [Deployment](deploy/DEPLOYMENT.md).

## Validate

```sh
npm run check
npm run test:postgres
```

Unit tests invoke capabilities through the shared engine boundary with
replaceable dependencies. The PostgreSQL suite verifies the Drizzle baseline,
constraints, role enforcement, migration locking/checksums, rollback, and
concurrent behavior against a real database.

### Slack and Telegram reminders

The browser **Reminders** page manages pending reminders, completion, snoozing,
and delivery receipts. An owner configures a bot token and destination; credentials
are encrypted with `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY` and never returned by the
API. Verification uses read-only provider methods. Enabling global delivery sends
all due, incomplete reminders to every enabled channel, including overdue items.
The deployment's automation worker must be running.

The worker schedules one delivery per reminder version and channel. Completing,
rescheduling or changing a channel before dispatch cancels stale work. Editing or
reopening a reminder creates a new version eligible for delivery. Pausing delivery
cannot recall an in-flight message. Explicit provider throttling retries at the
provider's minimum delay, up to five attempts. Timeouts, ambiguous provider errors
and interrupted sends stop with an unconfirmed outcome; inspect the destination
before snoozing to request another delivery. Delivery itself does not complete a
reminder. Changing configuration does not revive a canceled or failed occurrence.

Slack requires a bot token, `chat:write`, the appropriate conversation read scope,
and membership in the destination. See [Slack message delivery](https://docs.slack.dev/reference/methods/chat.postMessage/)
and [conversation verification](https://docs.slack.dev/reference/methods/conversations.info/).
Telegram requires a bot created through BotFather and a numeric chat ID; the user
must start the bot, or add it to a group with permission to send. Channels require
posting rights. See the [Telegram Bot API](https://core.telegram.org/bots/api).
