import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERCEL_API = "https://api.vercel.com";
const MIN_UPLOAD_INTERVAL_MS = 220;
const POLL_INTERVAL_MS = 4_000;
const DEPLOYMENT_TIMEOUT_MS = 30 * 60 * 1_000;

function fail(message) {
  throw new Error(message);
}

function runGit(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: options.encoding ?? "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    fail("Git is required, and this command must run from inside the repository.");
  }
}

function assertCleanWorkingTree() {
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (status) {
    fail(
      "Production deploys require a clean Git working tree. Commit or stash all intended changes, then retry.",
    );
  }
}

function globSource(glob) {
  let source = "";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];

    if (char === "*" && next === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const classBody = glob.slice(index + 1, end);
        source += `[${classBody.startsWith("!") ? `^${classBody.slice(1)}` : classBody}]`;
        index = end;
      }
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }

  return source;
}

function parseIgnoreRules(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      let pattern = negated ? line.slice(1) : line;
      const anchored = pattern.startsWith("/");
      pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!pattern) return null;
      return {
        negated,
        anchored,
        hasSlash: pattern.includes("/"),
        pattern,
        regex: new RegExp(`^${globSource(pattern)}$`),
      };
    })
    .filter(Boolean);
}

function ruleMatches(rule, filePath) {
  const prefixes = filePath
    .split("/")
    .map((_, index, parts) => parts.slice(0, index + 1).join("/"));

  if (rule.hasSlash || rule.anchored) {
    return prefixes.some((prefix) => rule.regex.test(prefix));
  }

  return prefixes.some((prefix) =>
    prefix.split("/").some((component) => rule.regex.test(component)),
  );
}

function isIgnored(filePath, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, filePath)) ignored = !rule.negated;
  }
  return ignored;
}

async function readProjectConfig() {
  let project;
  try {
    project = JSON.parse(
      await fs.readFile(path.join(ROOT, ".vercel", "project.json"), "utf8"),
    );
  } catch {
    fail(
      "Could not read .vercel/project.json. Restore the local link to the existing Vercel project before deploying.",
    );
  }

  if (
    typeof project.projectId !== "string" ||
    !project.projectId.startsWith("prj_") ||
    typeof project.orgId !== "string" ||
    !project.orgId.startsWith("team_") ||
    typeof project.projectName !== "string" ||
    !project.projectName
  ) {
    fail(".vercel/project.json does not contain the expected project and team identifiers.");
  }

  return project;
}

async function readVercelConfig() {
  try {
    const config = JSON.parse(await fs.readFile(path.join(ROOT, "vercel.json"), "utf8"));
    if (typeof config.buildCommand !== "string" || !config.buildCommand.trim()) {
      fail("vercel.json must define a non-empty buildCommand.");
    }
    return config;
  } catch (error) {
    if (error instanceof SyntaxError) fail("vercel.json is not valid JSON.");
    throw error;
  }
}

async function collectDeploymentFiles() {
  const [gitOutput, ignoreContents] = await Promise.all([
    Promise.resolve(
      runGit(
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { encoding: "buffer" },
      ),
    ),
    fs.readFile(path.join(ROOT, ".vercelignore"), "utf8"),
  ]);
  const rules = parseIgnoreRules(ignoreContents);
  const paths = [...new Set(gitOutput.toString("utf8").split("\0").filter(Boolean))];
  const files = [];

  for (const filePath of paths) {
    if (isIgnored(filePath, rules)) continue;
    const absolutePath = path.resolve(ROOT, filePath);
    if (!absolutePath.startsWith(`${ROOT}${path.sep}`)) {
      fail(`Refusing to upload a path outside the repository: ${filePath}`);
    }

    const stats = await fs.lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      fail(`Refusing to upload a symbolic link: ${filePath}`);
    }
    if (!stats.isFile()) continue;

    const data = await fs.readFile(absolutePath);
    files.push({
      file: filePath.split(path.sep).join("/"),
      data,
      sha: createHash("sha1").update(data).digest("hex"),
      size: data.byteLength,
    });
  }

  if (files.length === 0) fail("No deployment source files remain after applying .vercelignore.");
  return files;
}

function verifyDeploymentInputs(files) {
  const included = new Set(files.map((file) => file.file));
  const required = [
    "vercel.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/package.json",
    "artifacts/api-server/package.json",
    "artifacts/tw-stock-dashboard/package.json",
  ];
  const missing = required.filter((file) => !included.has(file));
  if (missing.length > 0) {
    fail(
      `.vercelignore or Git exclusions removed required deployment files: ${missing.join(", ")}`,
    );
  }

  if (
    included.has("scripts/deploy-vercel.mjs") ||
    [...included].some((file) => file.startsWith(".vercel/"))
  ) {
    fail("Deployment helpers and local Vercel link metadata must not be uploaded.");
  }
}

function assertCleanAfterBuild() {
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (status) {
    fail("The configured build changed tracked or unignored files. Review the build output before deploying.");
  }
}

function runProductionBuild(buildCommand) {
  console.log("Running the build command from vercel.json...");
  const result = spawnSync("sh", ["-lc", buildCommand], {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (result.error) fail(`Could not start the production build: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`The production build failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function apiUrl(pathname, teamId) {
  const url = new URL(pathname, VERCEL_API);
  url.searchParams.set("teamId", teamId);
  return url;
}

async function errorDetails(response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    const code = body.error?.code ?? body.code;
    const message = body.error?.message ?? body.message;
    return [code, message].filter((value) => typeof value === "string").join(": ");
  } catch {
    return "";
  }
}

async function assertOk(response, operation) {
  if (response.ok) return;
  const detail = await errorDetails(response);
  fail(
    `Vercel ${operation} failed with HTTP ${response.status}${detail ? ` (${detail})` : ""}.`,
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function uploadFile(file, token, teamId, previousStartTime) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wait = MIN_UPLOAD_INTERVAL_MS - (Date.now() - previousStartTime.value);
    if (wait > 0) await sleep(wait);
    previousStartTime.value = Date.now();

    let response;
    try {
      response = await fetch(apiUrl("/v2/files", teamId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
          "x-vercel-digest": file.sha,
        },
        body: file.data,
      });
    } catch {
      fail("Could not reach Vercel while uploading source files.");
    }

    if (response.ok) return;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : 1_000 * 2 ** attempt;
      await response.body?.cancel();
      await sleep(backoff);
      continue;
    }
    await assertOk(response, `source upload for ${file.file}`);
  }
}

async function createDeployment(files, project, token) {
  const body = {
    name: project.projectName,
    project: project.projectId,
    target: "production",
    files: files.map(({ file, sha, size }) => ({ file, sha, size })),
  };

  let response;
  try {
    response = await fetch(apiUrl("/v13/deployments", project.orgId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    fail("Could not reach Vercel to create the Production deployment.");
  }

  await assertOk(response, "deployment creation");
  return response.json();
}

async function waitForReady(deployment, project, token) {
  if (!deployment.id) fail("Vercel did not return a deployment ID.");
  const deadline = Date.now() + DEPLOYMENT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(
        apiUrl(`/v13/deployments/${encodeURIComponent(deployment.id)}`, project.orgId),
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch {
      fail("Could not reach Vercel while checking deployment status.");
    }
    await assertOk(response, "deployment status check");
    const current = await response.json();

    if (current.readyState === "READY") return current;
    if (["ERROR", "CANCELED", "CANCELLED", "DELETED"].includes(current.readyState)) {
      const details = [current.errorCode, current.errorMessage].filter(Boolean).join(": ");
      fail(
        `Vercel deployment ended in ${current.readyState}${details ? ` (${details})` : ""}.`,
      );
    }

    console.log(`Vercel deployment status: ${current.readyState ?? "unknown"}`);
    await sleep(POLL_INTERVAL_MS);
  }

  fail("Timed out while waiting for Vercel to finish the deployment.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const dryRun = args.includes("--dry-run");
  if (args.some((arg) => arg !== "--dry-run") || args.filter((arg) => arg === "--dry-run").length > 1) {
    fail("Usage: pnpm run deploy:vercel [-- --dry-run]");
  }

  const [project, vercelConfig] = await Promise.all([
    readProjectConfig(),
    readVercelConfig(),
  ]);

  if (dryRun) {
    const files = await collectDeploymentFiles();
    verifyDeploymentInputs(files);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    console.log(
      `Dry run only: ${files.length} files (${totalBytes.toLocaleString()} bytes) selected; no build, upload, or deployment was started.`,
    );
    return;
  }

  assertCleanWorkingTree();
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) fail("VERCEL_TOKEN is not available. Add it through Replit Secrets; never put it in source.");

  runProductionBuild(vercelConfig.buildCommand);
  assertCleanAfterBuild();

  const files = await collectDeploymentFiles();
  verifyDeploymentInputs(files);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.log(
    `Uploading ${files.length} source files (${totalBytes.toLocaleString()} bytes) to the linked Vercel project...`,
  );

  const previousStartTime = { value: 0 };
  for (const file of files) {
    await uploadFile(file, token, project.orgId, previousStartTime);
  }

  console.log("Creating a Production deployment without changing project settings...");
  const pending = await createDeployment(files, project, token);
  const ready = await waitForReady(pending, project, token);

  if (typeof ready.url !== "string" || !ready.url) {
    fail("Vercel reported READY but did not return the deployment URL.");
  }
  console.log(`Production deployment is READY: https://${ready.url}`);
  for (const alias of ready.alias ?? []) {
    console.log(`Production alias: https://${alias}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Vercel deployment failed.");
  process.exitCode = 1;
});
