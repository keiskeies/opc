// round331 premise probe: is "@openai/codex-sdk 装不上" (and the other 6) still true?
//
// The repo's own scripts/deps-resolvable.mjs says, verbatim, "只读、不装、不联网"
// (read-only, does not install, does not network) and its output header reads
// "解析不到（这些任务今天在这台机器上做不了，也不是没试）". Those are TWO different
// claims printed under ONE heading: "not currently installed" and "cannot be installed
// here". Only the first is what the script measures. round319 already caught the same
// shape for @langchain/* and round278 for playwright: a "装不上" that was really
// "never re-run the install". This probe re-runs it for all 7, in throwaway dirs,
// --ignore-scripts, and reports per-package: registry version / install exit / importable.
//
// Nothing in the repo is touched: each package gets its own fresh directory under
// .workbuddy/, and the repo's own node_modules is never written.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = "D:/item/opc/.workbuddy";

// The 7 rows the script currently files under "做不了", with the entry point to import
// when the install succeeds (subpath where the package uses exports maps).
const TARGETS = [
	{ name: "@modelcontextprotocol/sdk", ver: "1.32.2", entry: "@modelcontextprotocol/sdk/client/index.js", task: "5.7" },
	{ name: "@openai/codex-sdk", ver: "0.167.0", entry: "@openai/codex-sdk", task: "5.5" },
	{ name: "@qoder-ai/qoder-agent-sdk", ver: "1.0.59", entry: "@qoder-ai/qoder-agent-sdk", task: "5.6" },
	{ name: "@larksuiteoapi/node-sdk", ver: "1.76.0", entry: "@larksuiteoapi/node-sdk", task: "4.4" },
	{ name: "react", ver: "latest", entry: "react", task: "4.2/4.3" },
	{ name: "@xyflow/react", ver: "latest", entry: "@xyflow/react", task: "3.2" },
	{ name: "@capacitor/core", ver: "latest", entry: "@capacitor/core", task: "4.2" },
];

function run(cmd, args, cwd, ms) {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: ms, shell: process.platform === "win32" });
	return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const rows = [];
for (const t of TARGETS) {
	const dir = path.join(ROOT, "probe331-" + t.name.replace(/[^a-z0-9]+/gi, "_"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "probe331", private: true, type: "module" }, null, 2) + "\n");

	const spec = t.ver === "latest" ? t.name : t.name + "@" + t.ver;
	const inst = run("npm", ["i", "--ignore-scripts", "--no-audit", "--no-fund", spec], dir, 420_000);

	// importable? a real ESM import, not just "the directory exists"
	const probeFile = path.join(dir, "imp.probe.mjs");
	fs.writeFileSync(probeFile, "import(" + JSON.stringify(t.entry) + ").then(()=>console.log('IMPORT_OK')).catch((e)=>{console.log('IMPORT_FAIL '+e.message);process.exitCode=3;});\n");
	const imp = run(process.execPath, [probeFile], dir, 90_000);

	rows.push({
		task: t.task,
		name: t.name,
		install: inst.code === 0 ? "INSTALL_OK" : "INSTALL_FAIL(" + inst.code + ")",
		import: imp.out.includes("IMPORT_OK") ? "IMPORT_OK" : imp.out.includes("IMPORT_FAIL") ? "IMPORT_FAIL" : "NO_READ(" + imp.code + ")",
		note: (inst.code === 0 ? "" : inst.out.split(/\r?\n/).filter((l) => /npm error/.test(l)).slice(0, 2).join(" | ")),
	});
	console.log(rows[rows.length - 1].task.padEnd(9) + rows[rows.length - 1].name.padEnd(28) + rows[rows.length - 1].install.padEnd(18) + rows[rows.length - 1].import.padEnd(12) + rows[rows.length - 1].note);
}

const unlockable = rows.filter((r) => r.install === "INSTALL_OK" && r.import === "IMPORT_OK");
console.log("\n可装且可 import: " + unlockable.length + " / 7");
console.log(unlockable.map((r) => r.name + "(Task " + r.task + ")").join("\n") || "(none)");
