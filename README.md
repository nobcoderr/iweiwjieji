# CCA #23 researcher-owned live gate

Status: the first authorized run stopped before model/tool execution and cleaned
up all disposable refs. A redacted API/model preflight is prepared for one
diagnostic live-gate rerun; no credential disclosure has been observed.

Repository selected for the authorized live gate: `nobcoderr/iweiwjieji`.
The local `auth/` directory contains a temporary repository-scoped deploy key
and is deliberately excluded from any evidence or submission bundle.

This gate is intentionally separate from the existing mock-API PoC. It answers
the remaining production questions:

1. Does the exact `v1.0.239` production agent select
   `mcp__github_file_ops__commit_files` for the symlink path?
2. Does GitHub accept the production Create Tree -> Create Commit -> Update Ref
   sequence when inline tree content contains the live installation token?
3. After the committed file is publicly readable, can an observer with no
   workflow permission use only the recovered token for one harmless write?

## Safety model

- Use only a disposable, public, researcher-owned repository.
- Install the Claude GitHub App only on that repository.
- Store the researcher's Anthropic key as `ANTHROPIC_API_KEY`; never place it
  in a workflow file.
- The observer job has `permissions: {}` and receives no secret.
- A separate preflight job validates the API credential and selects an available
  Sonnet model without printing the credential or making a billable inference.
- The observer never prints the recovered GitHub token or committed content.
- The only protected action is creation of a uniquely named canary branch,
  immediately deleted with the recovered credential.
- A final cleanup job deletes only branches named `cca-live-gate` or beginning
  with `cca-live-gate-`, plus the unique canary branch.
- Stop after one run. Do not test against vendor or third-party repositories.

## Repository preparation

Place `observer.mjs` at `.github/cca-audit/observer.mjs` and install
`workflow-template.yml` as `.github/workflows/cca-live-gate.yml` on the default
branch. Create a disposable branch named `cca-live-gate` from that branch, then
add the following symlink and push it:

```text
docs/release-notes.md -> ../.git/config
```

Run the workflow manually from the trusted default-branch workflow definition
with `target_branch=cca-live-gate`.

The test is conclusive only when the observer reports all of:

```text
remoteDisclosureObserved = true
protectedActionStatus = 201
protectedActionSucceeded = true
cleanupStatus = 204
allAssertionsPassed = true
```

Interpret failures precisely:

- no changed ref or no token in the remote file: production-agent or remote
  commit gate failed;
- disclosure observed followed by `401`: GitHub revoked the token before it
  could be used;
- Create Tree/Commit/Ref rejected: server-side protection blocked publication;
- action never invokes `commit_files`: production-agent reachability failed.

## Important timing property

The production composite action revokes its App installation token in a
post-step. A verifier started after the action step therefore cannot establish
post-disclosure usability. The observer must already be running and must read
the credential from the published remote object before the action finishes.

Do not treat this prepared gate as evidence that the live chain succeeds. Only
the redacted JSON output from an executed researcher-owned run can close the
remaining gates.
