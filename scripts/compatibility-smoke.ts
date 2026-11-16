import { smokeAuditExtension } from "./smoke-audit.js";
import { spawn } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInferCloudProvider } from "../src/provider/infercloud.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface SmokeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  timeoutMs?: number;
  /** Optional extension under test; the default remains isolated stock configuration. */
  extensionPath?: string;
  /** Use Pi native API-key login, saved defaults, and model scopes without ambient credentials. */
  nativeLogin?: boolean;
  /** Installed archive package, discovered through Pi user settings. */
  packagePath?: string;
}

interface SmokeRequest {
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  estimatedCostUSD: number;
  aborted: boolean;
}

interface PhaseResult {
  phase: "text" | "tools" | "cancellation";
  textDeltas: number;
  tools: Record<string, number>;
  toolErrors: number;
  toolErrorCategories: string[];
  inputTokens: number;
  outputTokens: number;
  aborted: boolean;
  requests: SmokeRequest[];
}

interface PiRecord {
  type: string;
  success?: boolean;
  error?: string;
  aborted?: boolean;
  isError?: boolean;
  toolName?: string;
  result?: { content?: { type: string; text?: string }[] };
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: { input?: number; output?: number };
  };
}

/** Report fixed diagnostic categories without echoing provider error payloads. */
export function modelFailureCategory(message: string | undefined): string {
  const text = (message ?? "").toLowerCase();
  if (/context|too many tokens/.test(text)) return "context limit";
  if (/max_tokens|max_completion_tokens|output.*(?:limit|budget)/.test(text)) return "output limit";
  if (/401|403|api key|authorization/.test(text)) return "authentication";
  if (/429|rate.limit/.test(text)) return "rate limit";
  if (/402|balance|billing/.test(text)) return "billing";
  if (/503|no_compatible_offering|provider_unavailable/.test(text)) return "route unavailable";
  if (/400|422|invalid_request/.test(text)) return "request rejected";
  return "provider or transport error";
}

function toolFailureCategory(event: PiRecord): string {
  const text = (event.result?.content ?? []).map((part) => part.text ?? "").join(" ").toLowerCase();
  const tool = ["read", "edit", "bash"].includes(event.toolName ?? "") ? event.toolName : "unknown";
  const category = /enoent|no such file|file not found/.test(text) ? "missing file" :
    /command not found/.test(text) ? "missing executable" : /oldtext|exact text/.test(text) ? "edit target" :
    /required|invalid.*argument|invalid_type/.test(text) ? "invalid arguments" : "execution error";
  return `${tool}: ${category}`;
}

const piDirectory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const originalFile = 'export const greet = (name) => "Hello, " + name;\n';
const updatedFile = originalFile.replace("Hello, ", "Hi, ");

export function validateOptions(options: SmokeOptions): URL {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new Error("INFERCLOUD_BASE_URL must be a valid gateway URL ending in /v1.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash ||
      !url.pathname.replace(/\/$/, "").endsWith("/v1")) {
    throw new Error("Use an HTTPS gateway /v1 URL, or HTTP on loopback, without credentials or query parameters.");
  }
  if (!options.apiKey.trim() || !options.model.trim()) {
    throw new Error("INFERCLOUD_API_KEY and INFERCLOUD_PI_MODEL are required.");
  }
  for (const limit of [options.contextWindow, options.maxOutputTokens, options.timeoutMs ?? 120_000]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Supply positive integer context/output limits and timeout from verified runtime configuration.");
    }
  }
  if (options.maxOutputTokens >= options.contextWindow) {
    throw new Error("The output budget must leave space for the prompt within the context window.");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + "/";
  return url;
}

async function runPhase(
  options: SmokeOptions, agentDir: string, cwd: string,
  phase: PhaseResult["phase"],
): Promise<PhaseResult> {
  const source = join(cwd, "greeting.mjs");
  const verifier = join(cwd, "verify.mjs");
  const verifierCommand = "node '" + verifier.replaceAll("'", "'\\''") + "'";
  const prompts = {
    text: "Reply with a short greeting. Do not use tools.",
    tools: `Use read to inspect ${source}. Use edit to replace the literal Hello, with Hi, in that file. ` +
      `Use bash to run ${verifierCommand}. Then explain the command result briefly. ` +
      `Use these exact file paths. Do not modify ${verifier} or other files.`,
    cancellation: "Count from 1 to 10000, one number per line. Keep generating until you reach 10000. Do not use tools.",
  };
  const auditFile = join(agentDir, phase + "-usage.jsonl");
  const useProvider = Boolean(options.extensionPath || options.packagePath);
  const child = spawn(process.execPath, [join(piDirectory, "cli.js"),
    "--mode", "rpc", ...(options.nativeLogin ? [] : ["--provider", "infercloud", "--model", options.model]),
    "--thinking", "off", "--no-session", ...(options.packagePath ? [] : ["--no-extensions"]), "--no-mcp",
    "-e", join(agentDir, "audit.ts"),
    ...(options.extensionPath ? ["-e", options.extensionPath] : []),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--no-approve", ...(useProvider ? [] : ["--offline"]), ...(phase === "tools" ? ["--tools", "read,edit,bash"] : ["--no-tools"]),
  ], {
    cwd,
    env: { ...(useProvider ? { PATH: process.env.PATH, HOME: agentDir } : process.env),
      PI_CODING_AGENT_DIR: agentDir, INFERCLOUD_PI_AUDIT_FILE: auditFile, INFERCLOUD_BASE_URL: options.baseUrl,
      INFERCLOUD_API_KEY: options.nativeLogin ? undefined : options.apiKey,
      ...(options.nativeLogin ? { INFERCLOUD_BASE_URL: undefined } : {}), PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  const result: PhaseResult = { phase, textDeltas: 0, tools: {}, toolErrors: 0, toolErrorCategories: [], inputTokens: 0, outputTokens: 0, aborted: false, requests: [] };
  let sentAbort = false;
  let assistantFinished = false;
  let verifierPassed = false;
  child.stdout.setEncoding("utf8");
  // Consume diagnostics without reflecting provider payloads or credentials.
  child.stderr.resume();
  try {
    await new Promise<void>((done, fail) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new Error(`Pi ${phase} check timed out.`)), options.timeoutMs ?? 120_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          const summary = `Successful tools: read=${result.tools.read ?? 0}, edit=${result.tools.edit ?? 0}, bash=${result.tools.bash ?? 0}; tool errors=${result.toolErrors}`;
          fail(new Error(`${error.message} ${summary}${result.toolErrorCategories.length ? ` (${result.toolErrorCategories.join("; ")})` : ""}.`));
        }
        else done();
      };
      child.once("error", () => finish(new Error("Pi could not be started.")));
      child.once("close", () => finish(new Error(`Pi exited before the ${phase} check settled.`)));
      child.stdin.on("error", () => finish(new Error("Pi command channel closed unexpectedly.")));
      let buffer = "";
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) {
          finish(new Error("Pi emitted an oversized protocol record."));
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event: PiRecord;
          try { event = JSON.parse(line) as PiRecord; }
          catch { finish(new Error("Pi emitted invalid JSONL.")); return; }
          if (event.type === "response" && event.success === false) {
            const category = event.error?.includes("not available") ? "model unavailable" : event.error?.includes("No model") ? "no model" : event.error?.includes("API key") ? "authentication" : event.error?.includes("already") ? "busy" : "command";
            finish(new Error(`Pi rejected a ${category} command during the ${phase} check.`));
            return;
          }
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta" &&
              event.assistantMessageEvent.delta) {
            result.textDeltas++;
            if (phase === "cancellation" && !sentAbort) {
              sentAbort = true;
              child.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
            }
          }
          if (event.type === "tool_execution_end") {
            if (event.isError) {
              result.toolErrors++;
              const category = toolFailureCategory(event);
              if (!result.toolErrorCategories.includes(category)) result.toolErrorCategories.push(category);
              if (result.toolErrors >= 4) { finish(new Error("Pi could not recover from tool execution errors.")); return; }
            } else if (event.toolName) {
              result.tools[event.toolName] = (result.tools[event.toolName] ?? 0) + 1;
              if (event.toolName === "bash" && event.result?.content?.some((part) => part.type === "text" && part.text?.includes("PI_SMOKE_TOOL_OK"))) verifierPassed = true;
            }
          }
          if (event.type === "message_end" && event.message?.role === "assistant") {
            if (event.message.stopReason === "error") {
              finish(new Error(`Pi ${phase} request failed (${modelFailureCategory(event.message.errorMessage)}).`)); return;
            }
            assistantFinished = event.message.stopReason === "stop";
            const usage = event.message.usage;
            for (const count of [usage?.input, usage?.output]) {
              if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
                finish(new Error("Pi reported invalid token usage.")); return;
              }
            }
            result.inputTokens += usage?.input ?? 0;
            result.outputTokens += usage?.output ?? 0;
          }
          if (event.type === "agent_settled") {
            result.aborted = event.aborted === true;
            if (phase === "cancellation" ? !(sentAbort && result.aborted) : !assistantFinished || result.aborted) {
              finish(new Error(`Pi did not finish the ${phase} check as expected.`)); return;
            }
            finish();
          }
        }
      });
      child.stdin.write(JSON.stringify({ id: "smoke", type: "prompt", message: prompts[phase] }) + "\n");
    });
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
    await closed;
    clearTimeout(kill);
  }
  if (result.textDeltas === 0) throw new Error(`Pi produced no text stream during the ${phase} check.`);
  if (phase !== "cancellation" && (result.inputTokens === 0 || result.outputTokens === 0)) {
    throw new Error(`Pi received no input/output token accounting during the ${phase} check.`);
  }
  if (phase === "tools" && (!verifierPassed || ["read", "edit", "bash"].some((name) => !result.tools[name]))) {
    throw new Error(`Pi did not complete all required read, edit, and bash tools. ` +
      `Successful tools: read=${result.tools.read ?? 0}, edit=${result.tools.edit ?? 0}, bash=${result.tools.bash ?? 0}; ` +
      `verifier passed=${verifierPassed}; tool errors=${result.toolErrors}` +
      `${result.toolErrorCategories.length ? ` (${result.toolErrorCategories.join("; ")})` : ""}.`);
  }
  try {
    const records = await readFile(auditFile, "utf8");
    result.requests = records.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SmokeRequest);
  } catch { throw new Error("Pi did not produce its secret-free usage audit."); }
  return result;
}

export async function runCompatibilitySmoke(options: SmokeOptions) {
  const baseUrl = validateOptions(options);
  let response: Response;
  try {
    response = await fetch(new URL("models", baseUrl), {
      headers: { Authorization: `Bearer ${options.apiKey}` }, redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error("Gateway model discovery failed; check connectivity and the configured gateway URL."); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Gateway model discovery returned HTTP ${response.status}.`);
  }
  const catalog = await response.json().catch(() => null) as { data?: { id?: string }[] } | null;
  if (!Array.isArray(catalog?.data) || !catalog.data.some((entry) => entry?.id === options.model)) {
    throw new Error("The selected model is not present in this key's authorized model catalog.");
  }
  const root = await mkdtemp(join(tmpdir(), "infercloud-pi-smoke-"));
  const startedAt = new Date().toISOString();
  try {
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    await mkdir(agentDir, { mode: 0o700 });
    await mkdir(workspace);
    if (!options.extensionPath && !options.packagePath) await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { infercloud: {
      baseUrl: baseUrl.toString().replace(/\/$/, ""), api: "openai-completions",
      apiKey: "$INFERCLOUD_API_KEY", models: [{ id: options.model, input: ["text"],
        reasoning: false, contextWindow: options.contextWindow, maxTokens: options.maxOutputTokens,
        samplingParams: { temperature: 0 } }],
    } } }));
    if (options.extensionPath || options.packagePath) {
      await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { infercloud: {
        baseUrl: options.baseUrl,
        modelOverrides: { [options.model]: { samplingParams: { temperature: 0 } } },
      } } }));
    }
    if (options.nativeLogin) {
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
      let wrongEndpoint = false;
      const connection = createInferCloudProvider({ env: () => ({}), initialBaseUrl: runtime.getProvider("infercloud")?.baseUrl ?? options.baseUrl, fetch: async (input, init) => {
        if (!String(input).startsWith(options.baseUrl + "/models?")) { wrongEndpoint = true; throw new Error("Unexpected native login endpoint."); }
        return fetch(input, init);
      } });
      try {
        runtime.registerNativeProvider(connection.provider);
        await runtime.refresh({ providers: ["infercloud"], allowNetwork: false });
        await runtime.login("infercloud", "api_key", {
          signal: AbortSignal.timeout(10_000), notify() {},
          prompt: async (prompt) => { if (prompt.type !== "secret") throw new Error("Unexpected native login prompt."); return options.apiKey; },
        });
      } catch (error) {
        if (wrongEndpoint) throw new Error("Pi native login endpoint was not initialized from models.json.");
        throw error;
      } finally { connection.dispose(); }
    }
    await writeFile(join(agentDir, "audit.ts"), smokeAuditExtension);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      ...(options.packagePath ? { packages: [options.packagePath] } : {}),
      ...(options.nativeLogin ? { defaultProvider: "infercloud", defaultModel: options.model, enabledModels: ["infercloud/" + options.model] } : {}),
      retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false },
    }));
    await writeFile(join(workspace, "greeting.mjs"), originalFile);
    const verifier = 'import { greet } from "./greeting.mjs";\n' +
      'if (greet("Pi") !== "Hi, Pi") process.exit(1);\nconsole.log("PI_SMOKE_TOOL_OK");\n';
    await writeFile(join(workspace, "verify.mjs"), verifier);
    const phases: PhaseResult[] = [];
    for (const phase of ["text", "tools", "cancellation"] as const) {
      phases.push(await runPhase(options, agentDir, workspace, phase));
      if (phase === "tools" && (await readFile(join(workspace, "greeting.mjs"), "utf8") !== updatedFile ||
          await readFile(join(workspace, "verify.mjs"), "utf8") !== verifier)) {
        throw new Error("The tool check did not produce the expected edit or changed its verifier.");
      }
    }
    const pi = JSON.parse(await readFile(join(piDirectory, "../package.json"), "utf8")) as { version: string };
    return { piVersion: pi.version, nodeVersion: process.version, gateway: baseUrl.toString(), model: options.model,
      contextWindow: options.contextWindow, maxOutputTokens: options.maxOutputTokens,
      startedAt, finishedAt: new Date().toISOString(), phases,
      gatewayUsageReconciliation: "pending: inspect gateway records for this key and time window; Pi token counts alone do not verify billing",
      upstreamCancellation: "pending: verify gateway reservation release and provider cancellation",
    };
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function main() {
  if (process.env.INFERCLOUD_PI_LIVE_TEST !== "1") {
    throw new Error("Set INFERCLOUD_PI_LIVE_TEST=1 to enable billable live compatibility requests.");
  }
  const report = await runCompatibilitySmoke({
    ...(process.env.INFERCLOUD_PI_USE_EXTENSION === "1" ? { extensionPath: resolve("src/index.ts"), nativeLogin: true } : {}),
    baseUrl: process.env.INFERCLOUD_BASE_URL ?? "http://127.0.0.1:8081/v1",
    apiKey: process.env.INFERCLOUD_API_KEY ?? "",
    model: process.env.INFERCLOUD_PI_MODEL ?? "",
    contextWindow: Number(process.env.INFERCLOUD_PI_CONTEXT_WINDOW),
    maxOutputTokens: Number(process.env.INFERCLOUD_PI_MAX_OUTPUT_TOKENS),
    ...(process.env.INFERCLOUD_PI_TIMEOUT_MS ? { timeoutMs: Number(process.env.INFERCLOUD_PI_TIMEOUT_MS) } : {}),
  });
  const reportPath = process.env.INFERCLOUD_PI_REPORT_PATH ? resolve(process.env.INFERCLOUD_PI_REPORT_PATH) : resolve(".tmp/compatibility", `${Date.now()}.json`);
  const reportDir = dirname(reportPath);
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`Pi compatibility checks passed. Secret-free report: ${reportPath}\n`);
  process.stdout.write("Gateway usage reconciliation and upstream cancellation still require verification.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Compatibility check failed."}\n`);
    process.exitCode = 1;
  });
}
