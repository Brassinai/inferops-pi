import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));

/** Exercise the distributed archive, outside this checkout and its node_modules. */
export async function installPackedPackage() {
  const directory = await mkdtemp(join(tmpdir(), "infercloud-pi-package-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const packed = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: repository });
    const [archive] = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
    assert.ok(archive);
    const paths = archive.files.map((file) => file.path);
    assert.ok(paths.includes("src/index.ts"));
    for (const path of paths) assert.match(path, /^(?:src\/|docs\/|examples\/|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$)/);
    assert.ok(!paths.some((path) => /tasks\.md|node_modules|connection\.json|\.env|\.git/.test(path)));
    const client = join(directory, "client");
    await exec("npm", ["install", "--prefix", client, "--offline", "--ignore-scripts", "--legacy-peer-deps", "--omit=dev", "--package-lock=false", join(directory, archive.filename)]);
    const packagePath = join(client, "node_modules", "infercloud-pi");
    const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.dependencies, undefined);
    assert.deepEqual(manifest.pi, { extensions: ["./src/index.ts"] });
    const agentDir = join(directory, "agent");
    await exec(process.execPath, [join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "install", packagePath], {
      cwd: directory, env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" },
    });
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages: unknown[] };
    assert.ok(settings.packages.some((source) => typeof source === "string" && resolve(agentDir, source) === packagePath));
    return { packagePath, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
