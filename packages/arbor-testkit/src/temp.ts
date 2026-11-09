/**
 * The proof suite's temporary directories.
 *
 * A proof boots whole DSH profiles and creates project directories beside its
 * own `DSH_HOME`; both live under the system temp directory. They are proof
 * fixtures, not work the user asked to keep, so every one is registered here
 * and removed when the proof reports its result. A run of `pnpm proofs`
 * therefore leaves `/tmp` as it found it, and a single proof does the same.
 *
 * The removal is synchronous on purpose: `finishProof` runs after every
 * assertion and writes its line immediately before exiting, so an asynchronous
 * cleanup could be cut off by that exit. Only the temp directories this process
 * made are touched.
 */

import { existsSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Every directory this process made through {@link tempDir}. */
const temporaryDirectories = new Set<string>()

/** Make one fresh directory under the system temp directory, and remember it. */
export async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

/**
 * Remove one directory, unmounting the ovnfs checkout mount it holds when
 * arbor chose the real ovnfs backend.
 *
 * A mounted directory cannot be removed; arbor's host closes its workspace in
 * its own dispose, but the mount can outlive that when the daemon is the orb's
 * own binary. The unmount is best-effort and only the path this directory
 * owns; a host without FUSE simply removes the directory.
 */
function removeDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true })
    return
  } catch {
    // A mounted workspace survives the first removal; unmount it below.
  }
  const mount = join(directory, 'arbor', 'ovnfs', 'checkouts')
  if (existsSync(mount)) {
    spawnSync('fusermount3', ['-u', mount], { stdio: 'ignore' })
    if (existsSync(mount)) spawnSync('umount', [mount], { stdio: 'ignore' })
  }
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // A directory already gone, or one a test process still holds open, must
    // not hide the proof's own result.
  }
}

/** Remove every directory this process made through {@link tempDir}. */
export function removeTempDirs(): void {
  for (const directory of temporaryDirectories) removeDirectory(directory)
  temporaryDirectories.clear()
}
