#!/usr/bin/env node
// phi: run the pi-env tests only where the Rust daemon exists. Every suite here drives
// `daemon/target/debug/pi-env` (or `PI_ENV_DAEMON`); phi's CI image has no Rust toolchain, so
// a missing daemon skips the package instead of failing the monorepo run. Set
// PI_ENV_REQUIRE_DAEMON=1 to fail instead (what a daemon-building CI should do).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemon =
	process.env.PI_ENV_DAEMON ??
	resolve(packageDir, `daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`);

if (!existsSync(daemon)) {
	const message = `pi-env daemon not built (${daemon}); run \`npm run build:daemon\` in packages/env to test it.`;
	if (process.env.PI_ENV_REQUIRE_DAEMON) {
		console.error(message);
		process.exit(1);
	}
	console.log(`Skipping @earendil-works/pi-env tests: ${message}`);
	process.exit(0);
}

const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "--run", ...process.argv.slice(2)], {
	cwd: packageDir,
	stdio: "inherit",
});
process.exit(result.status ?? 1);
