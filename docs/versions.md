# Versions and compatibility

dsh-arbor is an integration, not a DSH release. It is built and tested against
exactly one DeepSeek Harness version, and it uses DSH internals that are not a
stable public API. This page is the canonical statement of that pin; the
README and the install guide summarize it.

## The pin

| Component | Pin | Where it comes from |
| --- | --- | --- |
| DeepSeek Harness | tag `dsh-v0.2.2-rc.1`, commit `66491b05e3` of `deepseek-ai/deepseek-harness` | npm packages `@deepseek-ai/dsh@0.2.2-rc.1` and the companion `@deepseek-ai/dsh-*` packages at `0.2.2-rc.1` |
| arbor | `2026.1109.1` | npm packages `@4fu/arbor-*`; `@4fu/arbor-errors` is `2026.1107.0`, the only published version |
| dsh-arbor packages | `2026.1110.2` | npm packages `@4fu/dsh-arbor-*`; the bundle and its 11 dependencies are published together |
| dsh-arbor-fonts | `2026.1110.0` | npm package `@4fu/dsh-arbor-fonts`, a separate repository |
| Node.js | `>=24.9.0` (developed on Node 26) | `engines` in the root `package.json`; the checkout runs the TypeScript sources, while the published packages ship JavaScript and declarations |
| pnpm | `11.28.5` | `packageManager` in the root `package.json`; `.agents/setup` installs that exact version |

`@deepseek-ai/cordis` is pinned separately at `4.1.0`. It is the Cordis runtime,
not a DSH package, and DSH's own packages pin it the same way.

## What a published package depends on

A profile install is not a checkout. `dsh plugin` runs pnpm inside
`$DSH_HOME/profiles/web` with `autoInstallPeers: false`, and DSH's profile
resolver routes an import of any package in the DSH installation to the
installation's own copy — unless the profile holds a copy of that name, which
Node then resolves first. A published package that lists a DSH runtime package
as a `dependency` therefore installs a second copy into the profile, arbor reads
that copy while DSH keeps using its own, and classes, services and scoped
contexts stop matching. `2026.1110.0` shipped this way: every new session failed
with `Agent preset binding requires a scoped context`.

So every package DSH itself loads — `@deepseek-ai/cordis`,
`cordis-plugin-loader`, and each `@deepseek-ai/dsh-*` package arbor imports — is
a `peerDependency` at the pinned version, mirrored by a `devDependency` so the
checkout, `pnpm check` and the proofs still install it. Only private libraries
stay `dependencies`: `@deepseek-ai/schemastery` (schema definitions, no service,
branded with a process-global symbol) and `zod` (argument validation), the same
split DSH's own plugins make, for example `@deepseek-ai/dsh-subagent-codex`.
`@4fu/arbor-*` packages are arbor's own and stay `dependencies` too.

## Live plugin changes

The web client recomposes its plugin graph in place, and 2026.1110.2 makes that
safe for this bundle's client half. Every DSH seat a package occupies, shadows
or wraps is released when the package disposes:

- `@4fu/dsh-arbor-ui` registers its sidebar row, its page and its two composer
  shadows through its own context, disposes them with it, and removes its
  locale namespace and stylesheet.
- `@4fu/dsh-arbor-ui-workspace` forwards `ctx.slots.register` with the caller's
  context, so DSH's own registrations stay DSH's; its picker and sidebar
  replacements read a page-wide filter, so a disposed package leaves the
  shipped components exactly as they were.

Disabling and uninstalling the bundle therefore leave the sidebar and the
current page working. Enabling it live re-applies the client half and restores
the Arbor row and page, but the host half cannot be mounted a second time:
DSH's loader cannot provide the `agents` service while the base `agent` row's
registry is still registered, so the arbor host, driver and facts rows wait.
The Arbor page then says that its channel is unavailable and asks for a DSH
restart; the client half also shows a notice on the page where the bundle was
switched on, saying in the UI's language that a DSH restart is needed. A restart
is also what arbor sessions need after a live enable.

A version update disposes the old package before it applies the new one. An
update from `2026.1110.1` is the one case the new package cannot make clean:
that version's registration wrapper owned DSH's own sidebar seats, so its
dispose removed the sidebar during the update. `2026.1110.2` notices that state
after the update, shows a notice and reloads the page once, which restores the
sidebar. A manual reload does the same thing.

The Arbor page's settings drawer changes arbor's real settings. It installs
`/env/settings.json` through the host's environment path, the same install the
model's own `reload` uses, and the host re-reads it immediately. The judge
modes, the window token budget and limits, the active-note budget and the
checkout retention are editable; no restart is involved. The workspace backend
and the shared folder are facts: both are settled when the host starts, so a
control there would change nothing. Judge candidate count and active-set share
are facts for the same reason (the default judge is built at host start).

The bundle's plugin page follows DSH's language through the plugin metadata
locale hook: the bundle carries all eight languages DSH ships, and each package
row carries English and Chinese. The preset's mode-picker copy carries the same
eight languages. The Arbor page, its drawer and its notices are English and
Chinese; DSH's locale fallback shows English in its other languages. DSH's
Agent presets settings section (not the mode picker) renders a custom preset's
host metadata verbatim and offers no client hook, so its description remains
the host declaration's English text.

## What happens on a different DSH version

Nothing in this repository promises compatibility with another DSH version.
A different version is unsupported and may fail in any of these ways:

- **Boot can fail.** The bundle patch disables DSH's base `agent` row and
  inserts a routing `AgentRegistry` in its place. That depends on the row name,
  on DSH allowing one `AgentFactory` per process, and on the loader's patch
  semantics.
- **Prompt sections can be missed.** The prompt bridge decides every official
  DSH prompt section by name. `proofs/12-official-sections.ts` reads the pinned
  DSH's registered names and fails when the table does not decide one. A newer
  DSH that registers a new section would fail that proof rather than let the
  section reach a window undecided.
- **The browser surface can stop registering.** The Arbor page and the
  composer's preset gate are pinned to DSH's client slot and preset
  registration shapes. `proofs/18-picker-pin.ts` fails when the shipped
  workspace bundle, the pick flow, the shipped service list or the pinned
  version moves.
- **The font plugin can stop serving.** `@4fu/dsh-arbor-fonts` uses DSH's exact
  Fetch registry (`HostConnectionFetch.register`) and the Arbor page's
  `data-arbor-text` contract. On a different DSH it may register no route, or
  receive 404 from another asset path.

An upgrade is a port, not a version bump: change every pin, re-read the DSH
source locations named in `docs/b0-findings.md`, `docs/b3-findings.md` and
`docs/b3b-projects-and-sandbox.md`, update the section table and the
registration checks, then run `pnpm check`, `pnpm proofs` and
`pnpm check:profile`. Do not merge an
upgrade whose pinned proofs fail. A release also republishes the bundle and its
11 dependencies at one new `YYYY.MDD.REVISION` version, because they name each
other exactly.

## How the pin is checked

- Every `@deepseek-ai/dsh*` dependency in the root manifest, `packages/*` and
  `proofs/` is an exact version, never `^` or `~`.
- Every package under `packages/` declares `engines.dsh: 0.2.2-rc.1`, the
  runtime requirement DSH reads before it loads a plugin or bundle.
- `pnpm check:pin` checks those manifests, every `engines.dsh`, and
  `DSH_PINNED_VERSION` in `packages/arbor-prompt/src/sections.ts` against
  `0.2.2-rc.1`. It also fails when a published package lists a DSH runtime
  package as a `dependency` instead of a `peerDependency`, and when a peer is
  not mirrored in `devDependencies`.
- `pnpm check:profile` builds and packs the release packages, installs the
  tarballs into a fresh DSH `0.2.2-rc.1` web profile the way `dsh plugin add`
  does, asserts the profile holds no second copy of a DSH runtime package, and
  creates an ordinary session and an arbor session through the HTTP RPC the web
  UI uses. CI runs it as the `profile-install` job.
- `proofs/12-official-sections.ts` and `proofs/18-picker-pin.ts` check the
  behavior behind the version, not only the number.
- CI runs the pin check, the type check, the proof suite, the profile install
  check and the live-toggle check (`pnpm check:live`, headless Chrome drives the
  Plugins page and switches the bundle off and on). The live-model job is
  optional and runs only when the repository variable `ARBOR_PROOF_LIVE` is `1`
  and a `DEEPSEEK_API_KEY` secret is configured.
