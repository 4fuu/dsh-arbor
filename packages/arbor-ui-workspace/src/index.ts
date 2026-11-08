/**
 * The dsh-arbor-ui-workspace node half.
 *
 * The empty host `apply` exists only so the plugin appears in the host
 * cordis.yml / Loader: every behavior lives in the browser half
 * (`exports["./client"]`), which the client module graph discovers from this
 * package's `dsh.client` declaration. There is nothing to do on the host — the
 * picker filter is a slot registration, which is browser state.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
