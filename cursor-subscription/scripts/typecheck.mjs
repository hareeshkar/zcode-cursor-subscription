#!/usr/bin/env node
/**
 * Type-check the shipped code, and fail on the defect class that has actually
 * bitten this project.
 *
 * Three defects in a row were the same shape: a value that can be absent in two
 * ways, with the writer and the reader disagreeing about which one means
 * "absent". `let toolCall = null` read by `!== undefined` discarded every
 * checkpoint ever received. A test can only pin a bug someone thought of; the
 * compiler catches the whole family at once, so this runs on every commit.
 *
 * The null-safety codes are **blocking**. The remaining diagnostics are mostly
 * `any`-documentation on dynamic objects (parsed JSON, `process` shims) rather
 * than runtime hazards, so they are reported as a burn-down count instead of
 * failing the build. Pretending the codebase is fully typed would be worse than
 * saying exactly how far it has got.
 *
 *   node scripts/typecheck.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tsc = join(root, "node_modules", ".bin", "tsc");

if (!existsSync(tsc)) {
	console.error(
		"typescript is not installed. Run `npm install` first — it is a dev-only tool.\n" +
			"The plugin itself still ships with no runtime dependencies.",
	);
	process.exit(2);
}

/**
 * The codes that mean "this could be null or undefined".
 *
 * All four are the same hazard: a dereference the writer believed was safe.
 */
const NULL_SAFETY_CODES = {
	TS18047: "possibly null",
	TS18048: "possibly undefined",
	TS2531: "object possibly null",
	TS2532: "object possibly undefined",
};

const result = spawnSync(tsc, ["--noEmit", "--pretty", "false"], {
	cwd: root,
	encoding: "utf8",
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const lines = output.split("\n").filter((line) => line.includes("error TS"));

const fatal = [];
const deferred = [];
for (const line of lines) {
	const match = /error (TS\d+)/.exec(line);
	const code = match?.[1];
	if (code && code in NULL_SAFETY_CODES) fatal.push(line);
	else deferred.push(line);
}

if (fatal.length > 0) {
	console.error(`\n${fatal.length} null-safety error(s) — this is the defect class that blocks:\n`);
	for (const line of fatal) console.error(`  ${line}`);
	console.error(
		"\nA value that can be absent in two ways, read with the wrong test, fails\n" +
			"silently: the fix is to make one of them unrepresentable, not to add a guard.\n",
	);
	process.exit(1);
}

if (deferred.length > 0) {
	console.log(
		`null-safety: clean. ${deferred.length} other diagnostic(s) remain, tracked as a burn-down.`,
	);
	const byCode = new Map();
	for (const line of deferred) {
		const code = /error (TS\d+)/.exec(line)?.[1] ?? "?";
		byCode.set(code, (byCode.get(code) ?? 0) + 1);
	}
	const summary = [...byCode.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([code, n]) => `${code}×${n}`)
		.join(" ");
	console.log(`  ${summary}`);
} else {
	console.log("type-check clean.");
}
