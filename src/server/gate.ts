import { spawn } from "node:child_process";
import path from "node:path";
import { ralphDirPath } from "./bookkeeping";
import type { RunSandboxContext } from "./sandbox/context";
import { runSandboxedCommand } from "./sandbox/srt";
import { errorMessage } from "@/shared/errorMessage";

/**
 * Spec 27: the repository gate, run by the orchestrator so the evaluator
 * judges its result instead of spending its budget producing it.
 *
 * A repository may declare one command, `make check` for instance. It runs in
 * the worktree under the evaluator's sandbox context before the evaluator
 * harness is built, once per evaluation cycle, and its result goes to
 * `.ralph/GATE.md` and into the evaluator prompt as evidence. Never a verdict:
 * the evaluator stays the one judge.
 */

export const GATE_FILE = "GATE.md";
/** The end of the gate's combined output that reaches the file and the prompt. */
export const GATE_OUTPUT_CHARS = 8_000;
/** A chatty gate must not fill memory; only the tail is ever read. */
const GATE_MAX_BUFFER = 16 * 1024 * 1024;

export type GateResult = {
  command: string;
  /** The exit code; null when the command was killed or never ran. */
  exitCode: number | null;
  /** True when the gate's own timeout killed it. */
  timedOut: boolean;
  /** Why the command could not be run at all, or null when it ran. */
  error: string | null;
  durationMs: number;
  startedAt: string;
  /** The tail of stdout and stderr together. */
  output: string;
};

export function gateFilePath(worktreePath: string): string {
  return path.join(/* turbopackIgnore: true */ ralphDirPath(worktreePath), GATE_FILE);
}

function tail(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= GATE_OUTPUT_CHARS ? trimmed : `…${trimmed.slice(trimmed.length - GATE_OUTPUT_CHARS)}`;
}

type Outcome = Pick<GateResult, "exitCode" | "timedOut" | "error" | "output">;

async function execute(
  toRun: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeout: number,
  signal: AbortSignal | undefined,
  ctx: RunSandboxContext,
): Promise<Outcome> {
  // The shell leads its own process group, tracked so the callers' reap
  // kills whatever a finished gate left in the background before the trusted
  // process writes GATE.md. Every way out the gate itself takes (its timeout,
  // a full buffer, an abort) kills the whole group: a signal to the shell
  // alone leaves a hung command's children running, holding the output pipes.
  const groups = process.platform !== "win32";
  ctx.markCommandStarted();
  const child = spawn("/bin/sh", ["-c", toRun], { cwd, env, detached: groups, stdio: ["ignore", "pipe", "pipe"] });
  if (groups && child.pid) ctx.trackProcessGroup(child.pid);
  const killGroup = () => {
    try {
      if (child.pid) process.kill(groups ? -child.pid : child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const ended = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stopped: "timeout" | "buffer" | "abort" | null;
    error: Error | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const out = { stdout: "", stderr: "" };
    let stopped: "timeout" | "buffer" | "abort" | null = null;
    const stop = (why: "timeout" | "buffer" | "abort") => {
      stopped ??= why;
      killGroup();
    };
    for (const name of ["stdout", "stderr"] as const) {
      child[name].setEncoding("utf8");
      child[name].on("data", (chunk: string) => {
        if (out[name].length + chunk.length > GATE_MAX_BUFFER) return stop("buffer");
        out[name] += chunk;
      });
    }
    const timer = setTimeout(() => stop("timeout"), timeout);
    const onAbort = () => stop("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null, error: Error | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal: exitSignal, stopped, error, ...out });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, exitSignal) => finish(code, exitSignal, null));
  });
  // Cancelled from outside: the caller owns that outcome.
  if (signal?.aborted) throw new Error("the gate was cancelled", { cause: signal.reason });
  const output = tail(`${ended.stdout}${ended.stderr}`);
  if (ended.stopped === "buffer") return { exitCode: null, timedOut: false, error: "output exceeded the gate's buffer", output };
  if (ended.stopped === "timeout") return { exitCode: null, timedOut: true, error: null, output };
  if (ended.error) return { exitCode: null, timedOut: false, error: errorMessage(ended.error), output };
  if (ended.code !== null) return { exitCode: ended.code, timedOut: false, error: null, output };
  return { exitCode: null, timedOut: false, error: `killed by ${ended.signal ?? "a signal"}`, output };
}

/**
 * Run the gate in the worktree, wrapped in the run's sandbox policy when it
 * has one, exactly as the acceptance probe runs a criterion. Never throws for
 * an outcome of the command itself; only an external abort escapes.
 */
export async function runGateCommand(opts: {
  command: string;
  worktreePath: string;
  ctx: RunSandboxContext;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<GateResult> {
  const { command, worktreePath, ctx, timeoutMs, signal } = opts;
  const startedAt = new Date();
  // The prefix's lines end in `|| true` with no separator of their own; the
  // command must be its own line, not the right-hand side of that `||`.
  const prefixed = ctx.commandPrefix ? `${ctx.commandPrefix}\n${command}` : command;
  const run = (toRun: string) => execute(toRun, worktreePath, ctx.env, timeoutMs, signal, ctx);
  let outcome: Outcome;
  try {
    outcome = ctx.srtConfig ? await runSandboxedCommand(prefixed, ctx.srtConfig, run, { tmpdir: ctx.tmpdir }) : await run(prefixed);
  } catch (e) {
    if (signal?.aborted) {
      await ctx.reap();
      throw e;
    }
    // A wrap that could not be built: the gate did not run, and says so.
    outcome = { exitCode: null, timedOut: false, error: errorMessage(e), output: "" };
  }
  // No reap here on the way out: both callers reap before writing GATE.md
  // and fail the run outright if any group survives.
  return {
    command,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    ...outcome,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** The `.ralph/GATE.md` text: what ran, how it ended, and the end of its output. */
export function renderGateFile(result: GateResult): string {
  const ending = result.timedOut
    ? `killed by the gate timeout after ${formatDuration(result.durationMs)}`
    : result.error
      ? `did not run: ${result.error}`
      : `exit ${result.exitCode}`;
  return [
    "# Repository gate",
    "",
    `Command: \`${result.command}\``,
    `Result: ${ending}`,
    `Duration: ${formatDuration(result.durationMs)}`,
    `Ran at: ${result.startedAt}`,
    "",
    `## Output, last ${GATE_OUTPUT_CHARS} characters`,
    "",
    "```",
    result.output || "(no output)",
    "```",
    "",
  ].join("\n");
}

/** The end of the gate's output quoted in the loop's repair task (spec 29). */
export const GATE_REPAIR_OUTPUT_CHARS = 3_000;

/**
 * Spec 29: the task handed back to the loop when the gate fails after DONE.
 * It quotes only the end of the output; the whole of it is in `.ralph/GATE.md`.
 */
export function gateRepairTaskText(result: GateResult): string {
  const output = result.output.slice(-GATE_REPAIR_OUTPUT_CHARS) || "(no output)";
  return [
    `Repair the repository gate: the orchestrator ran \`${result.command}\` in the worktree after you signalled DONE and it exited ${result.exitCode}.`,
    "",
    "The end of its output:",
    ...output.split("\n").map((line) => `  ${line}`),
    "",
    "Fix the underlying problem rather than the command. Run only the part of the gate that failed as this task's targeted check, not the whole gate command.",
  ].join("\n");
}

/** The prompt section built from `.ralph/GATE.md`; empty when there is no file. */
export function renderGateSection(gateMd: string): string {
  if (!gateMd.trim()) return "";
  return (
    "\nREPOSITORY GATE\n===============\n" +
    "The orchestrator ran this repository's gate command in the worktree before this attempt " +
    "started. Its result is below and in `.ralph/GATE.md`. Do not run it again. Judge it: a " +
    "non-zero exit is evidence for your verdict, not an automatic revise, and a gate killed for " +
    "time is a fact about the gate, not about the change.\n\n" +
    `${gateMd.trim()}\n`
  );
}
