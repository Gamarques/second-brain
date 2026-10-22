# Release artifacts

Second Brain uses Release Please from the `1.0.0` bootstrap. A release pull
request keeps the server and engine application versions, the root installer
contract, the engine MCP manifest, the Release Please manifest, and the
engine source version in agreement. The root `version.txt` is the canonical
version file for the simple release strategy and is verified against the tag
with every other version manifest.

The repository is configured as one root release component because the
published product spans the engine, server, admin, and installer contract.
Every extra file path is repository-root relative. Release Please updates the
workspace package versions, the server's exact engine dependency, and their
root lockfile entries together; traversing paths such as `../server` are not
valid release configuration.

The `bootstrap-sha` recovery anchor points at the merged but untagged 1.3.0
release commit. It prevents the next release pull request from rebuilding its
changelog from the beginning of the repository; Release Please ignores the
anchor after the next successful tagged release.

When a release pull request merges, the Release workflow creates the GitHub
release and publishes the artifact in the same workflow run. The publication
job resolves the tagged commit, checks out that exact SHA, runs
`npm run check`, verifies all version manifests against the tag, and builds a
deterministic `tar.gz` from the Git tree.

Release Please provides the release commit SHA. The workflow checks out the
tag with the authenticated checkout action and refuses to continue unless both
the tag and the checked-out commit resolve to that SHA.

The archive layout is repository-root relative. Entries are sorted regular
files with normalized modes, ownership, and modification time; for example,
workspace files such as `apps/engine/invokta.mcp.json`,
`apps/engine/src/...`, `apps/server/src/...`, and `.agents/...` retain
their repository-relative paths in the archive.
Wrapped `second-brain/...` layouts are rejected. The validator
rejects absolute and traversing paths, duplicate paths, directories, symbolic
links, hard links, unexpected metadata, trailing partial blocks, and archives
without the required manifests. Tracked `.agents/` and `.codex/` configuration
is included, as are intentional tracked `.claude/` files. Tracked
`.env.example` is included as documentation, while real environment files,
root Claude state, local Claude state and worktrees, credentials, installer
state, dependencies, and Git metadata are excluded. Exclusions also apply to
the normalized target of every tracked symbolic link; intentional links such as
`CLAUDE.md -> AGENTS.md` are still materialized as regular files.

## Artifact API contract

The workflow requests a GitHub OIDC token for the configured audience and
uses it for two API calls:

1. `POST /api/internal/installer-artifacts` with `product`, `version`,
   `commitSha`, `sha256`, and `byteSize`. The API returns the immutable
   `objectKey` and a short-lived signed `uploadUrl`.
2. `PUT` the exact archive bytes to the signed URL, then
   `POST /api/internal/installer-artifacts/activate` with the same identity
   metadata. The platform response shape is:

   ```json
   {
     "activated": true,
     "product": "second-brain",
     "version": "1.0.0",
     "commitSha": "<release commit>",
     "sha256": "<artifact digest>",
     "byteSize": 123
   }
   ```

   Publication succeeds only when the response reports `activated: true` and
   every returned identity field matches. `status: "active"` is also accepted
   for compatibility.

The expected object key is
`products/second-brain/<version>/<sha256>.tar.gz`. No object-storage or bucket
credential is stored in GitHub.

## Required GitHub configuration

Configure these non-secret repository variables:

- `INSTALLER_ARTIFACT_API_URL`: HTTPS base URL of the Example API.
- `INSTALLER_ARTIFACT_OIDC_AUDIENCE`: audience accepted by that API for this
  repository's GitHub OIDC tokens.

The platform must also allow the repository, its workflow reference, and the
release commit according to its internal GitHub OIDC claim policy.
