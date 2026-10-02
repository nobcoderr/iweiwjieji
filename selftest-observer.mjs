#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "cca-live-observer-test-"));
const work = path.join(root, "work");
const bare = path.join(root, "remote.git");
const syntheticToken = "ghs_RESEARCH_ONLY_live_gate_42";
let changedSha = null;
let protectedCreates = 0;
let protectedDeletes = 0;

function git(args, cwd = work) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function main() {
  mkdirSync(work);
  git(["init", "-q", "--bare", bare], root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "CCA Audit"]);
  git(["config", "user.email", "audit@example.invalid"]);
  mkdirSync(path.join(work, "docs"));
  writeFileSync(path.join(work, "docs", "release-notes.md"), "baseline\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "baseline"]);
  git(["branch", "cca-live-gate"]);
  git(["remote", "add", "origin", bare]);
  git(["push", "-q", "origin", "cca-live-gate"]);

  const server = http.createServer(async (req, res) => {
    const send = (status, body = "") => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (req.url?.startsWith("/raw/") && changedSha && req.url.includes(changedSha)) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(
        `[remote \"origin\"]\n  url = https://x-access-token:${syntheticToken}@github.com/research/owned.git\n`,
      );
      return;
    }
    if (req.method === "GET" && req.url?.includes("/git/ref/heads/")) {
      return send(200, { object: { sha: changedSha } });
    }
    if (req.method === "POST" && req.url?.endsWith("/git/refs")) {
      assert.equal(req.headers.authorization, `Bearer ${syntheticToken}`);
      protectedCreates++;
      return send(201, { ref: "refs/heads/proof" });
    }
    if (req.method === "DELETE" && req.url?.includes("/git/refs/heads/")) {
      assert.equal(req.headers.authorization, `Bearer ${syntheticToken}`);
      protectedDeletes++;
      return send(204);
    }
    return send(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "observer.mjs")], {
      env: {
        ...process.env,
        CCA_OWNER: "research",
        CCA_REPO: "owned",
        CCA_BRANCH: "cca-live-gate",
        CCA_RUN_ID: "selftest",
        CCA_GIT_REMOTE: bare,
        CCA_API_BASE: `http://127.0.0.1:${port}`,
        CCA_RAW_BASE: `http://127.0.0.1:${port}/raw`,
        CCA_POLL_MS: "50",
        CCA_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    await new Promise((resolve) => setTimeout(resolve, 250));
    git(["switch", "-q", "cca-live-gate"]);
    writeFileSync(
      path.join(work, "docs", "release-notes.md"),
      `published ${syntheticToken}\n`,
    );
    git(["add", "docs/release-notes.md"]);
    git(["commit", "-q", "-m", "affected"]);
    changedSha = git(["rev-parse", "HEAD"]);
    git(["push", "-q", "origin", "cca-live-gate"]);

    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(stderr, "");
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.remoteDisclosureObserved, true);
    assert.equal(result.protectedActionSucceeded, true);
    assert.equal(result.cleanupSucceeded, true);
    assert.equal(result.tokenMaterialPrinted, false);
    assert.equal(stdout.includes(syntheticToken), false);
    assert.equal(protectedCreates, 1);
    assert.equal(protectedDeletes, 1);
    console.log(
      JSON.stringify(
        {
          observerSelftestPassed: true,
          protectedCreates,
          protectedDeletes,
          rawTokenPrinted: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
