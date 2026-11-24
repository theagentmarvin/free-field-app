#!/usr/bin/env node
/**
 * check-setup.mjs - FreeField deploy readiness check.
 *
 * Dependency-free (Node 20+, built-in modules only). Safe to run any time:
 * it only READS files and runs `--version`-style commands. It never prints the
 * values inside .env files, only the names of keys that need attention.
 *
 * Usage (from the repo root):
 *   node .claude/skills/freefield-deploy/scripts/check-setup.mjs              # local demo + overview
 *   node .claude/skills/freefield-deploy/scripts/check-setup.mjs --deploy     # real deployment: deploy items become blockers
 *   node .claude/skills/freefield-deploy/scripts/check-setup.mjs --public-demo  # no-login public demo build
 *   Extra flags: --offline (skip network checks), --ascii (no emoji)
 *
 * Exit code: 1 when at least one blocker (❌) was found, otherwise 0.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

const args = new Set(process.argv.slice(2));
const MODE = args.has("--deploy") ? "deploy" : args.has("--public-demo") ? "public-demo" : "local";
const OFFLINE = args.has("--offline");
const ASCII = args.has("--ascii") || process.env.NO_EMOJI === "1";
const DEPLOYING = MODE !== "local";

const ICON = ASCII
  ? { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]", info: "[INFO]" }
  : { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " };

const results = [];
let section = "";
function add(level, label, detail = "", fix = "") {
  results.push({ section, level, label, detail, fix });
}
/** Missing deploy-only items are blockers when deploying, warnings otherwise. */
const deployLevel = () => (DEPLOYING ? "fail" : "warn");

// ---------------------------------------------------------------- helpers

function run(cmd, cmdArgs = [], timeoutMs = 15000) {
  // shell:true is needed on Windows for .cmd shims (pnpm, firebase, corepack).
  // Only fixed strings from this file are passed; no user input.
  const r = spawnSync([cmd, ...cmdArgs].join(" "), {
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, FIREBASE_CLI_EXPERIMENTS: process.env.FIREBASE_CLI_EXPERIMENTS ?? "" },
  });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
}

function findRepoRoot() {
  const looksLikeRoot = (dir) =>
    existsSync(path.join(dir, "pnpm-workspace.yaml")) && existsSync(path.join(dir, "firebase.json"));
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (looksLikeRoot(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Fall back to the location of this script: <root>/.claude/skills/freefield-deploy/scripts/
  const fromScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  return looksLikeRoot(fromScript) ? fromScript : null;
}

/** Minimal .env parser (KEY=VALUE, comments, quotes). Values never leave this process. */
function readEnvFile(file) {
  if (!existsSync(file)) return null;
  const out = new Map();
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    out.set(m[1], v);
  }
  return out;
}

const PLACEHOLDER = /<[^>]*>|your-project-id|your-firebase-project-id|your-domain|ci-placeholder|^changeme$/i;
const isPlaceholder = (v) => v === undefined || v === "" || PLACEHOLDER.test(v);

// ---------------------------------------------------------------- checks

const root = findRepoRoot();

section = "Repository";
if (!root) {
  add("fail", "FreeField repo not found", "No pnpm-workspace.yaml + firebase.json above this folder.",
    "Run this from the folder where you cloned free-field-app.");
} else {
  add("ok", "FreeField repo found", root);
  if (/[\\/](OneDrive|Dropbox|Google Drive|iCloud)/i.test(root)) {
    add("warn", "Repo is inside a cloud-synced folder (OneDrive/Dropbox/Drive/iCloud)",
      "Sync locks node_modules files during pnpm install (EPERM/EBUSY, broken installs) and uploads the git-ignored .env files to the cloud.",
      "Strongly recommended before pnpm install or any deploy: move or re-clone to a plain folder such as C:\\dev\\free-field-app or ~/dev/free-field-app.");
  }
}

section = "Tools";
const [major, minor] = process.versions.node.split(".").map(Number);
if (major >= 20) add("ok", `Node.js ${process.versions.node}`);
else add("fail", `Node.js ${process.versions.node} is too old`, "FreeField needs Node 20 or newer.",
  "Install the current LTS from https://nodejs.org and reopen the terminal.");

const corepack = run("corepack", ["--version"]);
const pnpmOut = run("pnpm", ["--version"]);
const pnpmVer = pnpmOut?.split(/\s+/).find((t) => /^\d+\.\d+\.\d+/.test(t));
let pinnedPnpm = null;
if (root) {
  try {
    pinnedPnpm = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).packageManager?.replace(/^pnpm@/, "") ?? null;
  } catch { /* ignore */ }
}
if (pnpmVer) {
  const pMajor = Number(pnpmVer.split(".")[0]);
  if (pMajor === 10) add("ok", `pnpm ${pnpmVer}`, pinnedPnpm ? `repo pins ${pinnedPnpm}` : "");
  else add("warn", `pnpm ${pnpmVer} (repo expects 10.x)`, pinnedPnpm ? `repo pins ${pinnedPnpm}` : "",
    corepack ? "Run: corepack enable   (then pnpm follows the version pinned in package.json)" : `Run: npm i -g pnpm@${pinnedPnpm ?? "10"}`);
} else {
  add("fail", "pnpm not found", "Needed to install and build FreeField.",
    corepack ? "Run: corepack enable   (ships with Node; may need an admin terminal on Windows)" : `Run: npm i -g pnpm@${pinnedPnpm ?? "10"}`);
}
add(corepack ? "ok" : "info", corepack ? `corepack ${corepack.split(/\s+/)[0]}` : "corepack not available",
  corepack ? "can provide the pinned pnpm" : "Fine if pnpm is already installed.");

const gitOut = run("git", ["--version"]);
if (gitOut) add("ok", gitOut.split("\n")[0]);
else add("warn", "git not found", "Needed to clone and to pull FreeField updates later.", "Install from https://git-scm.com/downloads");

let firebaseCmd = null;
const globalFb = run("firebase", ["--version"], 30000);
if (globalFb) {
  firebaseCmd = "firebase";
  add("ok", `firebase-tools ${globalFb.split(/\s+/).pop()} (global)`);
} else if (root) {
  const bin = process.platform === "win32" ? "firebase.cmd" : "firebase";
  const local = [path.join(root, "node_modules", ".bin", bin), path.join(root, "packages", "ff-firestore", "node_modules", ".bin", bin)]
    .find((p) => existsSync(p));
  if (local) {
    firebaseCmd = `"${local}"`;
    add(DEPLOYING ? "warn" : "ok", "firebase-tools only installed locally (repo dev dependency)", path.relative(root, local),
      "Deploy guide uses the global CLI: npm i -g firebase-tools");
  }
}
if (!firebaseCmd) add(deployLevel(), "firebase-tools not found", "The Firebase command line, used to deploy.",
  "Run: npm i -g firebase-tools   (then: firebase login, which opens a browser sign-in)");

if (firebaseCmd && DEPLOYING) {
  const list = run(firebaseCmd, ["login:list", "--json"], 30000);
  let accounts = null;
  try { accounts = JSON.parse(list.slice(list.indexOf("{"))).result; } catch { /* ignore */ }
  if (Array.isArray(accounts) && accounts.length > 0) add("ok", `Firebase CLI signed in (${accounts.length} account${accounts.length > 1 ? "s" : ""})`);
  else add("fail", "Firebase CLI not signed in", "", "In a VS Code terminal run: firebase login   (a browser window opens; sign in with the company Google account)");
}

const javaOut = run("java", ["-version"]);
const javaMatch = javaOut?.match(/version "(\d+)(?:\.(\d+))?/);
let javaMajor = javaMatch ? Number(javaMatch[1]) : null;
if (javaMajor === 1 && javaMatch[2]) javaMajor = Number(javaMatch[2]);
if (javaMajor && javaMajor >= 21) add("ok", `Java ${javaMajor}`, "only used by the local emulator tests");
else if (javaMajor) add("warn", `Java ${javaMajor} (emulator tests need 21+)`, "Optional: not needed to build or deploy.",
  "Only if you run pnpm test:emulator: install JDK 21 (e.g. Temurin, https://adoptium.net).");
else add("info", "Java not found", "Optional: only the local emulator tests need it (JDK 21).");

section = "Dependencies";
if (root) {
  if (existsSync(path.join(root, "node_modules"))) add("ok", "Workspace dependencies installed");
  else add("warn", "Workspace dependencies not installed", "", "Run: pnpm install --frozen-lockfile");
  const fnMods = path.join(root, "packages", "ff-firestore", "functions", "node_modules");
  if (existsSync(fnMods)) add("ok", "Cloud Functions dependencies installed");
  else add(deployLevel(), "Cloud Functions dependencies not installed", "The functions folder has its own npm lockfile; pnpm install does not cover it.",
    "Run: npm ci --prefix packages/ff-firestore/functions");
}

// ---------------------------------------------------------------- config

section = "Configuration";
let projectIds = [];
let defaultProject = null;
if (root) {
  const rcPath = path.join(root, ".firebaserc");
  try {
    const rc = JSON.parse(readFileSync(rcPath, "utf8"));
    const projects = rc.projects ?? {};
    defaultProject = projects.default ?? null;
    projectIds = [...new Set(Object.values(projects).filter((v) => typeof v === "string" && !isPlaceholder(v)))];
    if (!defaultProject || isPlaceholder(defaultProject)) {
      add(MODE === "deploy" ? "fail" : "warn", ".firebaserc still has the placeholder project id", "",
        "Put your Firebase project id under \"default\" in .firebaserc (or run: firebase use --add)");
    } else {
      const aliases = Object.entries(projects).map(([a, p]) => `${a} -> ${p}`).join(", ");
      add("ok", ".firebaserc points at a real project", aliases);
    }
  } catch {
    add(deployLevel(), ".firebaserc missing or unreadable", "", "Restore it from git: it should contain {\"projects\":{\"default\":\"<id>\"}}");
  }

  const envDir = path.join(root, "apps", "settings");
  const prodPath = path.join(envDir, ".env.production");
  const prod = readEnvFile(prodPath);
  const REQUIRED = [
    "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID",
    "VITE_FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_APP_ID",
    "VITE_EXPECTED_FIREBASE_PROJECT_ID",
  ];
  if (MODE === "public-demo") {
    const demo = prod?.get("VITE_FF_DEMO_AUTH");
    if (demo === "true") add("ok", "Public demo build: VITE_FF_DEMO_AUTH=true in apps/settings/.env.production");
    else add("fail", "Public demo needs VITE_FF_DEMO_AUTH=true", "apps/settings/.env.production",
      "Set VITE_FF_DEMO_AUTH=true (and VITE_FF_DEMO_READONLY=true if your version supports it) for a no-login demo.");
  } else if (!prod) {
    add(deployLevel(), "apps/settings/.env.production not created yet", "Holds the web app's Firebase settings.",
      "Copy apps/settings/.env.production.example to apps/settings/.env.production, then fill it from Firebase Console > Project settings > Your apps.");
  } else {
    const missing = REQUIRED.filter((k) => isPlaceholder(prod.get(k)));
    if (missing.length === 0) add("ok", "apps/settings/.env.production has all Firebase keys filled", "(values not shown)");
    else add(deployLevel(), "apps/settings/.env.production: keys still empty or placeholder", missing.join(", "),
      "Fill these from Firebase Console > Project settings > Your apps > Web app config.");

    const pid = prod.get("VITE_FIREBASE_PROJECT_ID");
    const expected = prod.get("VITE_EXPECTED_FIREBASE_PROJECT_ID");
    if (!isPlaceholder(pid) && !isPlaceholder(expected)) {
      if (pid === expected) add("ok", "VITE_EXPECTED_FIREBASE_PROJECT_ID matches VITE_FIREBASE_PROJECT_ID");
      else add("fail", "VITE_EXPECTED_FIREBASE_PROJECT_ID does not match VITE_FIREBASE_PROJECT_ID",
        "The app refuses to start on a mismatch.", "Make both keys the same project id.");
    }
    if (!isPlaceholder(pid) && defaultProject && !isPlaceholder(defaultProject)) {
      if (projectIds.includes(pid)) add("ok", ".env.production project is one of the .firebaserc projects");
      else add("fail", ".env.production project is not in .firebaserc", "The build would talk to a different project than you deploy to.",
        "Use the same project id in both files.");
    }
    const demo = prod.get("VITE_FF_DEMO_AUTH");
    if (demo === "true") add("fail", "VITE_FF_DEMO_AUTH=true in .env.production", "That is the no-login demo: anyone could act as admin.",
      "Set VITE_FF_DEMO_AUTH=false for a real deployment.");
    else add("ok", "Demo login is off (VITE_FF_DEMO_AUTH is not \"true\")");
    if (prod.get("VITE_FIREBASE_USE_EMULATOR") === "true") add("fail", "VITE_FIREBASE_USE_EMULATOR=true in .env.production", "",
      "Set VITE_FIREBASE_USE_EMULATOR=false for any deployed build.");
    const region = prod.get("VITE_FIREBASE_FUNCTIONS_REGION");
    if (region && region !== "us-central1") add("warn", "VITE_FIREBASE_FUNCTIONS_REGION is not us-central1",
      "The Cloud Functions code sets no region, so they deploy to us-central1.",
      "Remove the key unless the functions code was changed to deploy to that region.");
  }

  // Vite loads .env.local and .env.production.local too; they override or add keys.
  for (const name of [".env.production.local", ".env.local"]) {
    const extra = readEnvFile(path.join(envDir, name));
    if (!extra) continue;
    // .env.production beats .env.local, but .env.production.local beats both.
    const risky = [...extra.keys()]
      .filter((k) => k.startsWith("VITE_FIREBASE") || k.startsWith("VITE_FF_DEMO") || k === "VITE_EXPECTED_FIREBASE_PROJECT_ID")
      .filter((k) => name === ".env.production.local" || !prod?.has(k));
    if (risky.length) add("warn", `apps/settings/${name} also sets build keys`, risky.join(", "),
      "Vite reads it during the production build too, so these keys end up in the deployed app. Move them or rename the file before building.");
  }

  // Cloud Functions params: packages/ff-firestore/functions/.env.<project-id>
  if (MODE !== "public-demo") {
    const ids = projectIds.length ? projectIds : [];
    if (!ids.length) {
      add(deployLevel(), "Cloud Functions settings file not checked", "Needs a real project id in .firebaserc first.");
    }
    for (const id of ids) {
      const rel = `packages/ff-firestore/functions/.env.${id}`;
      const fn = readEnvFile(path.join(root, rel));
      if (!fn) {
        add(id === defaultProject ? deployLevel() : "warn", `${rel} not created yet`, "Holds APP_ORIGIN and BOOTSTRAP_ADMIN_EMAILS for the server code.",
          `Copy packages/ff-firestore/functions/.env.example to ${rel} and fill it.`);
        continue;
      }
      const origin = fn.get("APP_ORIGIN");
      if (isPlaceholder(origin)) add(deployLevel(), `${rel}: APP_ORIGIN not set`, "Invite links would point at localhost.",
        "Set APP_ORIGIN to the site address, e.g. https://field.yourcompany.com (no trailing slash).");
      else if (!/^https:\/\/[^/]+$/.test(origin)) add("warn", `${rel}: APP_ORIGIN looks malformed`, "(value not shown)",
        "It must be https://host with no path and no trailing slash.");
      else add("ok", `${rel}: APP_ORIGIN set`);
      const emails = fn.get("BOOTSTRAP_ADMIN_EMAILS");
      if (isPlaceholder(emails) || /@example\.com/i.test(emails)) add("warn", `${rel}: BOOTSTRAP_ADMIN_EMAILS empty or still the example`,
        "Needed only for the in-app 'first admin' button.", "Set it to the email of the person who will be the first admin.");
      else add("ok", `${rel}: BOOTSTRAP_ADMIN_EMAILS set`);
    }
  }

  const dist = path.join(root, "apps", "settings", "dist");
  if (existsSync(path.join(dist, "index.html"))) {
    const age = Math.round((Date.now() - statSync(path.join(dist, "index.html")).mtimeMs) / 3600000);
    const hasDemoAssets = existsSync(path.join(dist, "seed")) || existsSync(path.join(dist, "samples"));
    if (MODE === "deploy" && hasDemoAssets) add("warn", "apps/settings/dist contains demo seed/sample files", "",
      "Rebuild with: pnpm build:selfhost   (drops ~150 MB of demo files)");
    else add("info", `A web build exists (apps/settings/dist, ${age} h old)`, "Rebuild after any change to .env.production.");
  }
}

// ---------------------------------------------------------------- network

const HOSTS = [
  ["registry.npmjs.org", "installing packages"],
  ["github.com", "getting FreeField updates"],
  ["accounts.google.com", "firebase login (browser sign-in)"],
  ["oauth2.googleapis.com", "firebase login tokens"],
  ["firebase.googleapis.com", "Firebase CLI project management"],
  ["firebasehosting.googleapis.com", "deploying the website"],
  ["cloudfunctions.googleapis.com", "deploying Cloud Functions"],
  ["firestore.googleapis.com", "database (app + rules deploy)"],
  ["identitytoolkit.googleapis.com", "sign-in by email link"],
  ["securetoken.googleapis.com", "keeping users signed in"],
  ["firebasestorage.googleapis.com", "file storage (photos, models, PDFs)"],
  ["storage.googleapis.com", "functions upload + emulator download"],
];

async function probe(host) {
  try {
    await dns.lookup(host);
  } catch {
    return "dns";
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(`https://${host}/`, { method: "HEAD", signal: ctrl.signal, redirect: "manual" });
    return "ok"; // any HTTP status means the TLS connection worked
  } catch {
    return "https";
  } finally {
    clearTimeout(t);
  }
}

if (!OFFLINE) {
  section = "Network";
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const outcomes = await Promise.all(HOSTS.map(async ([h, why]) => [h, why, await probe(h)]));
  const bad = outcomes.filter(([, , r]) => r !== "ok");
  if (!bad.length) add("ok", `All ${HOSTS.length} Google/npm/GitHub hosts reachable over HTTPS`);
  for (const [h, why, r] of bad) {
    const level = proxy ? "warn" : deployLevel();
    add(level, `${h} not reachable (${r === "dns" ? "name lookup failed" : "HTTPS failed"})`, `used for: ${why}`,
      proxy ? "A proxy is configured; this check does not use it. Confirm with IT that the host is allowed."
        : "Ask IT to allow this host (see references/it-request-template.*.md, proxy section).");
  }
}

// ---------------------------------------------------------------- report

const order = ["Repository", "Tools", "Dependencies", "Configuration", "Network"];
const title = { local: "local demo", deploy: "real deployment", "public-demo": "public no-login demo" }[MODE];
console.log(`\nFreeField setup check (mode: ${title})${OFFLINE ? " [offline]" : ""}\n`);
for (const s of order) {
  const rows = results.filter((r) => r.section === s);
  if (!rows.length) continue;
  console.log(s);
  for (const r of rows) {
    console.log(`  ${ICON[r.level]} ${r.label}${r.detail ? `  - ${r.detail}` : ""}`);
    if (r.fix && r.level !== "ok") console.log(`       fix: ${r.fix}`);
  }
  console.log("");
}
const fails = results.filter((r) => r.level === "fail").length;
const warns = results.filter((r) => r.level === "warn").length;
console.log(`Summary: ${fails} blocker(s), ${warns} warning(s).`);
if (MODE === "local" && !fails) console.log("Next: --deploy re-runs the check for a real deployment.");
process.exit(fails ? 1 : 0);
