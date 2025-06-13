import { spawn } from "node:child_process";
import { existsSync, readFileSync, promises } from "node:fs";
import path from "node:path";
import { argv } from "node:process";
import { getGitRef } from "./git-ref.mjs";

const TEMP_DIR = "temp";
const repoUrl = argv?.[2];
if (!repoUrl) throw new Error("GitHub repository URL required");

async function execute(command, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const child = spawn(command, { shell: true, cwd });
    child.stdout.on("data", (data) => !data.includes("npm warn exec") && (stdout += data));
    child.stderr.on("data", (data) => !data.includes("npm warn exec") && (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(`Command failed: ${command}\n${stderr}`)));
  });
}

async function detectPM(cwd) {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(path.join(cwd, "deno.lock"))) return "deno";
  return "npm";
}

async function getWorkspaces(cwd) {
  const data = await execute("npx @monorepo-utils/get-workspaces-cli --format=json", cwd);
  return JSON.parse(data);
}

async function main() {
  try {
    if (!process.env.CI) throw new Error("NPM Preview is only available in GitHub Actions (CI environment).");

    const { repo, branch } = await getGitRef(repoUrl);
    const shortBranch = /^[a-f0-9]{40}$/.test(branch) ? branch.slice(0, 7) : branch;

    await promises.rm(TEMP_DIR, { recursive: true, force: true });
    await execute(`npx degit ${repo}${branch ? `#${branch}` : ""} ${TEMP_DIR}`);

    const packageManager = await detectPM(TEMP_DIR);
    if (packageManager === "deno") throw new Error("Unsupported package manager: deno. Supported managers are npm, bun, pnpm, yarn.");

    const workspaces = await getWorkspaces(TEMP_DIR);
    const publicPackages = workspaces.filter((x) => !x.packageJSON?.private && x.packageJSON?.version && x.packageJSON?.name);

    const rootPkgPath = path.join(TEMP_DIR, "package.json");
    let rootPkg = {};
    if (existsSync(rootPkgPath)) {
      rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"));
      if (rootPkg.name && rootPkg.version && !rootPkg.private) {
        publicPackages.push({
          location: TEMP_DIR,
          packageJSON: rootPkg,
        });
      }
    }

    if (publicPackages.length === 0) {
      const privatePackages = workspaces.filter((x) => x.packageJSON?.private && x.packageJSON?.version && x.packageJSON?.name);
      const invalidWorkspaces = workspaces.filter((x) => !x.packageJSON?.version || !x.packageJSON?.name);

      if (privatePackages.length > 0) {
        throw new Error(`No publishable packages found.\n` + `Found ${privatePackages.length} valid package(s), but all are marked as private.\n` + `To publish a package, remove "private: true" from its package.json`);
      } else if (invalidWorkspaces.length > 0) {
        const packageList = invalidWorkspaces.map((x) => `- ${x.packageJSON?.name || "unknown"}` + (x.packageJSON?.version ? "" : " (missing version)") + (x.packageJSON?.name ? "" : " (missing name)")).join("\n");
        throw new Error(`No valid packages found.\n` + `Found ${invalidWorkspaces.length} workspace(s) missing required fields:\n` + `${packageList}\n\n` + `All packages must have both "name" and "version" in their package.json`);
      } else {
        throw new Error("No valid packages found in the repository.");
      }
    }

    console.log("🚀 Starting preview publish process...");
    console.log(`🔗 Source: https://github.com/${repo}/tree/${shortBranch}`);

    console.log("📥 Installing dependencies...");
    await execute(`${packageManager} install`, TEMP_DIR);
    console.log("✅ Dependencies installed.");

    const hasPackages = workspaces.length > 0 && publicPackages.length > 0;
    const buildablePackages = publicPackages.filter((x) => x.packageJSON?.scripts?.build);
    if (rootPkg.scripts?.build) {
      const workspaceNote = hasPackages && buildablePackages.length > 0 ? ` (includes ${buildablePackages.length} workspace package${buildablePackages.length > 1 ? "s" : ""})` : "";

      console.log("🔧 Building via root package script...");
      await execute(`${packageManager} run build`, TEMP_DIR);
      console.log(`✅ Root package built${workspaceNote}.`);
    } else if (hasPackages) {
      if (buildablePackages.length > 0) {
        console.log(`🔧 Building ${buildablePackages.length} workspace package(s)...`);
        for (const pkg of buildablePackages) {
          console.log(`➡️ Building package: ${x.packageJSON?.name}`);
          await execute(`${packageManager} run build`, pkg.location);
        }
        console.log("✅ Workspace packages built.");
      } else {
        console.log("⚠️ No buildable packages found in workspaces.");
      }
    } else {
      console.log("ℹ️ No build step required.");
    }

    console.log("📦 Publishing preview...");
    publicPackages.forEach((x) => console.log(`📝 Publishing package: ${x.packageJSON?.name} [./${path.relative(TEMP_DIR, x.location)}]`));

    await execute(`npx pkg-pr-new publish ${publicPackages.map((x) => `"./${path.relative(TEMP_DIR, x.location)}"`).join(" ")} --packageManager=${packageManager} ${[packageManager.includes("npm") ? "--peerDeps" : ""]} --comment=off`, TEMP_DIR);

    const workflowBranch = process.env.GITHUB_REF_NAME;
    const currentRepo = process.env.GITHUB_REPOSITORY;
    const summaryMd = [
      `### 📦 NPM Preview for [\`${repo}\`](https://github.com/${repo}/tree/${branch})`,
      "",
      "> [!WARNING]  ",
      `> Packages published from the [\`${workflowBranch}/\`](../../tree/${workflowBranch}) branch will overwrite any existing packages.`,
      "",
      ...publicPackages.map((pkg) => `- [\`${pkg.packageJSON?.name}@${pkg.packageJSON?.version}\`](https://pkg.pr.new/${currentRepo}/${pkg.packageJSON?.name}@${workflowBranch})`)
    ].join("\n");
    if (process.env.GITHUB_STEP_SUMMARY) {
      await promises.writeFile(process.env.GITHUB_STEP_SUMMARY, summaryMd);
    }

    console.log("✅ Preview published successfully.");
  } catch (error) {
    console.error("❌ Process failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
