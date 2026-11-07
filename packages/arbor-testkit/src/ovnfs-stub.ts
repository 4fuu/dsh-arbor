/**
 * Put a functional `ovnfs` stand-in on PATH for the proofs.
 *
 * The real ovnfs binary is not installed in the proof environment, so without
 * this the host falls back to the plain-directory workspace and the
 * checkout/apply flow cannot be exercised. `openWorkspace` resolves the binary
 * as `ovnfs` on PATH, so a proof that wants the ovnfs backend calls
 * {@link useOvnfsStub} before it boots: it writes an executable wrapper named
 * `ovnfs` into a fresh directory and prepends that directory to `PATH`. The
 * wrapper execs `node` on the fixture `ovnfs-stub.mjs`, which implements the
 * `ctl` admin protocol `@4fu/arbor-workspace-ovnfs` speaks.
 *
 * The directory is left on disk (under the system temp directory); it is inert
 * once the proof process exits.
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The absolute path of the stub script. */
export const OVNFS_STUB: string = fileURLToPath(new URL('./fixtures/ovnfs-stub.mjs', import.meta.url))

/**
 * Install the ovnfs stand-in on PATH and return the directory it lives in.
 * Idempotent within one process: a second call returns the first directory.
 */
let installed: string | undefined
export async function useOvnfsStub(): Promise<string> {
  if (installed !== undefined) return installed
  const dir = await mkdtemp(join(tmpdir(), 'arbor-ovnfs-bin-'))
  const wrapper = join(dir, 'ovnfs')
  await writeFile(wrapper, `#!/bin/sh\nexec node ${JSON.stringify(OVNFS_STUB)} "$@"\n`, 'utf8')
  await chmod(wrapper, 0o755)
  process.env['PATH'] = `${dir}${delimiter}${process.env['PATH'] ?? ''}`
  installed = dir
  return dir
}
