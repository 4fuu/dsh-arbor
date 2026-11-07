/**
 * The end of a proof: report, then leave.
 *
 * A proof boots a whole DSH profile and mounts the arbor host, and both own
 * process-level resources. The arbor host arms a timer per live window (its
 * idle period) and one per retired chain (its workspace retention, a week by
 * default), and `Arbor.close()` clears them — but the host's own dispose is
 * fire-and-forget from a cordis effect, so a close that does not run to the
 * end leaves them armed and the proof process, and with it the whole suite,
 * stays alive. That is intermittent: it was observed twice in a full suite run
 * (proof 1 and proof 8, both after printing their final line) and never in a
 * single proof run. DSH's own smoke harness has the same problem and answers
 * it by running every fixture in a subprocess with a timeout
 * (`DEFAULT_PROCESS_TIMEOUT_MS` in `@deepseek-ai/dsh-loader-smoke`).
 *
 * A proof's claim is about behavior, not about a clean exit, so the runner
 * exits once the report is out. The assertions have all run by then, and a
 * proof that hangs *before* this call — a turn that never ends, a `waitFor`
 * deadline — still hangs, which is what should happen.
 */

/** Report one proof's result and exit the process. */
export function finishProof(label: string, failures: readonly string[]): void {
  const ok = failures.length === 0
  const line = ok ? `${label} OK` : `${label} FAILED: ${failures.join('; ')}`
  process.exitCode = ok ? 0 : 1
  // The write callback runs once the line has reached the operating system, so
  // an explicit exit cannot truncate the report the way a bare process.exit
  // after console.log can.
  process.stdout.write(`${line}\n`, () => { process.exit(ok ? 0 : 1) })
}
