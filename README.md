<p align="center">
  <a href="https://github.com/exowatt-oss/phi">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/phi-logo.svg">
      <img alt="phi logo" src="docs/assets/phi-logo-light.svg" width="128">
    </picture>
  </a>
</p>

# phi

![Status: maintained](https://img.shields.io/badge/status-maintained-brightgreen) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Created at [Exowatt](https://exowatt.com). phi is a minimal, extensible agent harness that you can make your own.

## About this fork

phi is an MIT-licensed fork of [Pi by Mario Zechner](https://github.com/earendil-works/pi), maintained by Exowatt. It adds remote sessions, MCP, a configurable hub client, subagents, and workspace-state extensions. No Exowatt services or private hub bundles are required. Upstream retains its copyright; see [LICENSE](LICENSE) and [NOTICE](NOTICE). This repository is not endorsed by the upstream maintainers.

Adapt phi to your workflows, not the other way around. Customize phi with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md). Bundle them as [packages](packages/coding-agent/docs/packages.md) and share via Git or a registry you control. This fork's workspace packages are private to prevent publication under the upstream npm scope.

Ask phi to build what you want, or install an extension that does it your way.

Use phi [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [TypeScript SDK](packages/coding-agent/docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Node.js 22.19 or newer and npm are required. Clone this repository and build from source; do **not** use pi.dev's installers or the upstream npm package to install this fork.

```bash
git clone https://github.com/exowatt-oss/phi.git
cd phi
npm ci --ignore-scripts
npm run build:offline
./pi-test.sh --no-env
```

`./pi-test.sh --no-env` launches phi without ambient API keys for a safe first run. For regular use with your configured keys, run `node packages/coding-agent/dist/bundle/cli.js`. Run `/login` to connect a built-in provider. phi starts with no Exowatt services configured.

## Configuration

The optional hub uses `PHI_HUB_URL` (default `http://127.0.0.1:8787`); run your own server or configure a reachable hub before `/hub login`. The optional Feads integration uses `FEADS_URL` (default `http://127.0.0.1:8788`) and requires its own token; without credentials it sends no presence events. The optional binary updater is for self-hosted release feeds only: `PHI_UPDATE_BASE_URL` defaults to localhost, and `autoUpdate` is off by default. A feed must serve `versions.json`, the per-release binary archives and `phi-install.sh`; installed binaries need a local `phi-version.json` alongside them. This public source checkout does not ship an installer or a hosted feed. Source builds should update through Git instead. LLM providers use your own API keys or `models.json`; there is no preconfigured company gateway. A self-hosted provider named `gateway` can opt into LiteLLM `auto` response metadata. `phi auth token` reads only `PHI_AUTH_TOKEN_PROVIDER` (default `gateway`) and uses `PHI_AUTH_TOKEN_BASE_URL` (default `http://127.0.0.1:8790`); it does not fetch credentials. See [settings](packages/coding-agent/docs/settings.md) and [provider models](packages/coding-agent/docs/models.md).

## Run with Nix

In a local checkout, `nix build .` and `nix run .` can build and run the fork. The pinned public model catalog is in `nix/model-catalog.json`. This is separate from upstream's `stable` release channel.

## Packages

This monorepo contains the phi CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Typed host runtime for hot-reloadable plugins, contracts, replicated state, and RPC over JSON links |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For upstream Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

phi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox phi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `phi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `phi` process in a local container for simple isolation.
- **OpenShell**: run the whole `phi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the DCO contribution workflow and [AGENTS.md](AGENTS.md) for development commands. Upstream Pi plans are in its [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build:offline # Build all packages with committed model data
npm run check         # Lint, format, and type check (see AGENTS.md)
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Building standalone binaries from release source

From a tagged checkout with the committed model data, build a standalone binary locally:

```bash
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

`--offline-model-data` uses the committed model data without refreshing provider catalogs. The script installs dependencies and builds with runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- `packages/coding-agent/install-lock/` records the dependency closure; this fork is built from source.
- Local release smoke tests use the same tarball packer. No npm publication is configured for this fork.
- Local release installs use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT. Upstream Pi by Mario Zechner and Exowatt's modifications retain the MIT terms in [LICENSE](LICENSE); attribution and dependency notes are in [NOTICE](NOTICE).

## Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/exowatt-oss/phi/security/advisories/new). See [SECURITY.md](SECURITY.md); do not open a public issue.
