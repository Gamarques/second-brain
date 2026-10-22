# Getting Started with Second Brain 1.0

> This guide in Portuguese: [Este guia em português](./getting-started.pt-BR.md)

This guide installs a private Second Brain server and connects it to any MCP
client that supports OAuth discovery, dynamic client registration, and
Authorization Code with PKCE, or a static bearer token on the same MCP URL.

Second Brain 1.0 is a fresh-install-only release. Do not connect it to a
database or Docker volume created by an earlier version. There is no in-place
upgrade or automatic import path.

## Before you start

You need:

- a machine or VPS with Docker Engine and Docker Compose v2;
- a public HTTPS hostname for remote MCP access;
- an OpenRouter account, API key, and an explicit spending limit;
- the Second Brain source tree;
- a backup plan for PostgreSQL.

Node.js 22.20 or newer is also required for local development. The Compose
deployment builds and runs Node inside the image.

The server stores your data, but model processing is remote. Text needed for
embeddings, grounded answers, reviewed ingestion, and daily dreaming is sent
through OpenRouter to upstream model providers. The service requests
zero-data-retention routing and denies provider data collection by default;
review provider policies before storing sensitive information.

## 1. Create a fresh environment

Copy the example configuration:

```sh
cp .env.example .env
```

Open `.env` and replace at least:

- `POSTGRES_PASSWORD` with a unique database password;
- `OPENROUTER_API_KEY` with your key;
- `SECOND_BRAIN_PUBLIC_URL` with the final HTTPS origin, without a path;
- `SECOND_BRAIN_PUBLIC_HOST` with that origin's hostname;
- `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY` with canonical base64url for 32 random
  bytes.

Generate the encryption key once and back it up:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Keep `.env` private. Do not commit or paste it into an AI conversation.

For local-only OAuth testing, a loopback HTTP origin is accepted. A remote
deployment must use HTTPS and should keep PostgreSQL and the diagnostic service
ports bound to `127.0.0.1`.

## 2. Start the clean v1 stack

Start the services:

```sh
docker compose up -d --build
docker compose ps
```

Follow startup logs:

```sh
docker compose logs -f migrate auth engine admin automation-worker
```

The `migrate` service applies the bundled Drizzle migrations in journal order
before the other services start. It refuses an unmanaged nonempty `public`
schema, verifies migration order and checksums, and uses a PostgreSQL advisory
lock so two deployments cannot migrate concurrently.

If migration reports an unknown, missing, reordered, or changed migration,
stop. Do not edit the ledger or an applied migration to force startup. Confirm
that the database is new and that the image and `drizzle/` directory belong to
the same build.

## 3. Bootstrap the first account

Run the initial account bootstrap in an interactive terminal:

```sh
docker compose run --rm auth node dist/services/auth/bootstrap-account.js
```

Enter an email and a strong password. The transaction creates:

- one UUID account holding the `owner` role;
- the deployment's automation settings with UTC as its initial timezone;
- active memory, decision, and knowledge-chunk embedding spaces bound to the
  configured provider/model/revision and v1 recipes.

Repeating the exact normalized email, password, and provider identity verifies
the live account, its role, the singleton settings row, and the three spaces,
then returns the same IDs. Any mismatch or corruption fails closed and never
creates a second account. Invalid OpenRouter or embedding-provider configuration
also fails before writing.

The deployment serves one brain, and bootstrap does not create or name it.
Version 1.0 does not include an additional-account provisioning or
role-management surface.

Bootstrap is interactive-only. Run it from a trusted terminal and never put the
account password in `.env`, Compose, deployment arguments, or logs. Without
stdin/stdout TTY support it fails with
`Account bootstrap requires an interactive terminal.`

### Configure the administration panel

Restart the model runtimes after owner bootstrap:

```sh
SECOND_BRAIN_DEPLOY_MODE=wait-engine bash deploy/deploy.sh
```

Open `${SECOND_BRAIN_PUBLIC_URL}/admin` and sign in through the existing OAuth
server with an active `admin` or `owner` account. The panel uses Authorization
Code with S256 PKCE and creates no separate identity or password. It is served
by the hardened `admin` service through Traefik, while its diagnostic port 3002
stays bound to loopback by default.

## 4. Connect an OAuth-capable MCP client

Use this server URL in the client:

```text
https://your-host.example/mcp
```

A compatible client discovers the protected resource and authorization server,
registers dynamically, opens the browser login, requests consent, and then
discovers the tool catalog. Sign in with the account created in section 3.

This repository verifies the generic MCP/OAuth protocol boundary. It does not
claim that a particular ChatGPT, Claude, Cursor, or Codex release is certified.
Client setup screens and model tool-selection behavior change independently.

If the client caches an older catalog, remove the server connection and add it
again. The v1 catalog contains 55 capabilities and includes `context_get`,
`brain_search`, knowledge-document browsing, the four reviewed-ingestion steps,
and `dreaming_report_get`.

## 5. Connect with a static bearer token

OAuth stays enabled when you add a static token. Set both values in `.env`,
then recreate the engine service:

```sh
# INVOKTA_HTTP_BEARER_TOKEN must contain at least 32 characters.
# INVOKTA_HTTP_PRINCIPAL_ID is the UUID printed by bootstrap.
docker compose up -d engine
```

Use the same server URL. Send the token as an HTTP bearer credential:

```text
https://your-host.example/mcp
Authorization: Bearer YOUR_TOKEN
```

Keep `INVOKTA_HTTP_AUTH_MODE=oauth` so browser OAuth clients continue to work.
Exclusive `INVOKTA_HTTP_AUTH_MODE=bearer` turns OAuth off and is only for
deployments that do not need the authorization server.

The token binds to one existing active account. It does not grant a role. The
account's current database role is still checked on every invocation.

## 6. Test shared context

Ask the client to call `context_get` at the start of a session. Include a short
purpose, such as "continue the backend architecture decision." The response is
a bounded snapshot of the brain's relevant memories, decisions, tasks,
reminders, goals, and priorities, plus the knowledge-base catalog and a people
index. For "who is" or "what do you know about" questions, call `brain_search`
so memories, knowledge documents, and people are searched together.

Then test continuity:

1. Create a task, memory, or decision in one connected client.
2. Open another compatible client with the same account.
3. Call `context_get`, `brain_search`, or `brain_ask` from that client.
4. Confirm that the response cites the stored record.

Attaching a record to a project is optional. Every capability that accepts a
`projectId` also accepts the payload without one, and a record with no project
is general information. On an update, omitting `projectId` keeps the current
project and passing an explicit `null` detaches the record.

Use `handoffs_create` to save a bounded continuation note before changing
clients and `handoffs_list` to recover it. The server guarantees shared data
when a tool is called; it cannot force an uncontrolled third-party model to
call tools automatically.

For conversation ingestion, keep model extraction separate from writes:

1. call `ingestion_propose` with the excerpt and an idempotency key;
2. inspect the cited proposal set;
3. call `ingestion_review` to accept or reject persisted proposals;
4. call `ingestion_commit` for the reviewed set;
5. use `ingestion_status` after a retry or lost response.

## 7. Enable dreaming safely

The automation worker starts with the stack, but daily dreaming is disabled by
default and its safe initial mode is `preview`. Version 1.0 deliberately has no
MCP capability for starting a run, changing a schedule, or enabling apply.

Enablement, timezone, daily local time, execution limits, and apply policy are
trusted operational settings. Configure them in the OAuth-protected
administration panel. Enforce dollar-denominated spending limits in the
OpenRouter dashboard; the worker does not enforce a local USD budget. Do not
expose a database update or worker entry point to an AI client as a substitute.

In **Nightly review**, use **Configure model and API key** to open the daily
review model directly. In **Settings**, enter your key, then use **Test and
activate your AI** to choose the feature and find models with ZDR and structured
outputs. Run **Test this configuration** to check the selected model with the
draft key or saved key. Each test is a small paid request with synthetic content.
The catalog is advisory; the test confirms current routing with your key.

A model saved in the panel overrides the server setting. The assistant shows
the resolved model, including server defaults. Save edits, then use **Apply
settings**. Compare the saved revision with the observed revision for each
service, especially `automation-worker`. A missing or expired observation does
not confirm activation. Editing a model or key invalidates the displayed test
result; testing itself never saves or activates configuration.

Open **AI consumption** to compare requests, reported tokens, charged credits,
duration and failures by feature or model. Tracking starts with this release;
missing costs remain unknown and totals may be partial. Optional 30-day spending
notices appear on this page and are stored in this browser. They include all
features regardless of filters, do not stop requests, and exclude unreported
charges. Prompts, responses and keys are not stored in consumption records.

Return to **Nightly review**, set the time and time zone together, choose the
review mode, and save the schedule. The time zone determines both when the review
runs and which civil day it covers. The next-run timestamp is labeled as your
device's time; it may differ from the scheduled local time.

If a review fails with `DREAMING_PROVIDER_FAILED`, check the OpenRouter key,
credits, and model compatibility using the settings link beside the error.
This generic code does not identify the upstream cause. A terminal failed
review has no automatic retries left. Select its day in **Review calendar** to
inspect all attempts and open a completed report. After fixing the provider,
choose **Reprocess in preview** on the failed attempt. This creates one new job
with the original time zone and period, using the currently loaded model. The
original attempt and any earlier effects remain unchanged. The new job always
generates a preview. Concurrent requests reuse the same replay; a failed replay
can be retried again. Active and completed attempts cannot be reset.

Enqueuing the same date with **Run now** still returns the existing canonical
job; use the calendar action to reprocess a failed attempt.

Open **Review learning** to inspect imported proposals and completed nightly
preview suggestions. Choose a source and switch between pending suggestions
and review history. For imported learning, approve or reject each suggestion,
choose **Save review**, then confirm **Apply approved suggestions**. Tasks with
no destination list must be rejected. Saving decisions alone creates no records.

For nightly suggestions, compare **Current memory** with **Proposed memory**
and read the source evidence. **Approve** checks the evidence again and may use
paid models to verify and index a new memory version. Changed targets, removed
evidence and incomplete snapshots cannot be approved. **Reject** saves your
decision without changing memories or using AI. Approval preserves the original
preview report and records its result in the review history.

When enabled by trusted operations, the worker processes the last completed
civil day in the brain's IANA timezone. It writes a bounded report with cited
insights and memory proposals. Automatic effects are limited to grounded memory
creation and separately verified memory version updates; it never changes
tasks, reminders, decisions, documents, people, projects, goals, priorities,
or permissions.

Clients read a stored result with `dreaming_report_get`. The capability may
select the latest report, a local date, or a run ID. It never starts a job or
calls a model. `report: null` means no matching completed report exists.

## 8. Use the browser workspace

**Home** opens on a question box. Ask across current memories, documents,
people, projects, decisions, goals and tasks. Answers include numbered source
excerpts and document links. If the retrieved records cannot answer the
question, the panel says so. Search and answers may incur AI costs. **Stop**
cancels the current request; a late answer cannot replace a newer question.
The same question box is available on every page as a side panel: select
**Ask your brain** in the header or press Ctrl+J (⌘+J on a Mac). Inside a
project or document folder the panel searches that context first; switch to
**Whole brain** to widen it.

Open **Projects** and select a project to view its linked context. Section
counts cover all matching records; each section loads a page at a time. Expand
**Read details** to inspect stored content, open documents, or complete and
reopen tasks. **Ask about this project** limits the question to that project.
Current decisions and memories are shown instead of superseded versions.

Below the question box, **Home** shows overdue tasks and reminders, deadlines
in the next 24 hours, checks that need attention, the latest nightly recap and
its unresolved questions, and how many memory suggestions await your approval.
Read an insight's evidence before choosing **Create task** or
**Create reminder**. Review the text, select a task list and optional project,
or provide a future reminder time, then confirm. You can create a task list
inside the dialog if needed. Dates in the form use your browser's time zone.

A completed linked task/reminder or **Mark reviewed** removes the question from
the home. Marking reviewed preserves the report and does not complete
existing work. These blocks do not call a model and show a notice when their
bounded lists omit additional records. New reminder delivery must be configured
separately from creating the reminder.

## 9. Receive reminders in Slack or Telegram

Open **Reminders** in the browser panel. The page separates channel setup, reminder
management and delivery history. The owner adds a channel and follows the instructions
for its service. Keep a dedicated bot and invite it only to the intended destination.
Tokens are stored encrypted; leaving the token blank when editing preserves it.

Saving an enabled channel verifies bot access without sending a test message. Then
select **Enable delivery** and confirm: every enabled channel receives each due,
incomplete reminder, including overdue ones. The reminder text becomes visible to
people in the destination. New reminders can be created here or from a home insight.
Times in the browser use your browser timezone.

Use **Mark complete** to close a reminder, or **Snooze** to choose a future time and
request another delivery. Delivery does not mark a reminder complete. Pausing stops
future dispatches, but cannot recall a message already in flight. A change to the
reminder or channel can cancel an old queued delivery; snooze to schedule a new one.

History distinguishes waiting, sending, delivered, retrying, canceled, failed and
unconfirmed outcomes. Throttled requests retry up to five attempts, respecting the
provider delay. Unconfirmed sends are not retried automatically: inspect Slack or
Telegram before requesting another delivery, since the provider may have received it.
After fixing a failed channel, snooze the reminder to send again.

## Privacy and account erasure

Account erasure is not an MCP capability. This prevents an AI client from
requesting account-wide deletion. The persistence layer has
an internal erasure transaction that pseudonymizes actor attribution, purges
OAuth artifacts, and deletes the account row. The brain's content belongs to
the deployment rather than to an account, so it survives with that account's
attribution removed.

If the erased account was the deployment's last account, the operator can run
bootstrap again to create a replacement owner. The deployment-owned content,
settings, and embedding spaces remain in place.

A production operator must expose that transaction only through a separately
authenticated, human-controlled administrative workflow before advertising
self-service deletion. Coordinate live-data erasure with backup retention:
deleting a live account does not erase older backups until those backups expire.

Individual task, reminder, and memory delete capabilities are destructive,
require an administrative role, and use idempotency keys. Their reach is
narrow: task/reminder deletion purges the canonical entity and its owned
versions, links, and delivery state; memory deletion purges only that memory
lineage from memory retrieval/history. Independent ingestion source excerpts,
dreaming evidence/reports, and handoff prose require the retention or erasure
flow that owns those copies. Review the capability contract before invocation.

## Updates and backups

Back up the entire PostgreSQL database, including OAuth state and signing keys.
A content-only restore is not a complete service restore.

Before a deployment:

1. run `npm run check`;
2. run `npm run test:postgres` against the isolated test service;
3. back up PostgreSQL;
4. deploy one immutable image and its matching `drizzle/` migration files;
5. verify `migrate`, `auth`, `engine`, `admin`, and `automation-worker` logs.

Never edit a migration that has been applied. Generate a new Drizzle migration
for a deliberate schema change.

Changing the embedding model, model revision, recipe, dimensions, or distance
metric requires a controlled re-embedding operation. New vectors go into a
`preparing` embedding space, are verified for complete coverage and retrieval
quality, and are promoted atomically. Do not relabel or compare vectors from
different spaces.

## Troubleshooting

### Migration refuses to run

Confirm that this is a fresh v1 database and that the image matches the
migration directory. A checksum or ordering error is a safety stop. Do not
delete ledger rows, rename migration files, or reuse an earlier product volume.

### A local command rejects the account

Trusted internal direct invocation requires an existing UUID account:

```sh
export SECOND_BRAIN_ACCOUNT_ID="REPLACE_WITH_ACCOUNT_UUID"
```

There is no default internal identity. The account must be active and hold a
role that permits the capability. Public clients connect through
OAuth-protected MCP HTTP or a configured static bearer token.

### The client connects but does not use context

Tool discovery does not control model behavior. Tell the client explicitly to
call `context_get`, or put that call in a controlled session-start harness.
Use `handoffs_create` before switching clients when continuation is important.

### The dreaming report is empty

`report: null` is expected when dreaming is disabled, no daily run has
completed, or the selected date/run does not exist. The report capability never
wakes the worker. Check trusted automation settings, worker heartbeats, and
sanitized worker logs as an operator.
