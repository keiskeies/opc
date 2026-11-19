// round331 probe: what does buildGatewayDeps DO with a charter whose harness_defaults
// names a harness other than the one actually being run?
//
// Claim under test (from reading runtime.ts:420 + gateway-runner.ts:77):
//   the live path reads exactly ONE key, "claude-code", out of harness_defaults,
//   while the charter schema accepts ANY string key: z.record(z.string(), z.record(...)).
//   The charter HTTP endpoint passes harness_defaults through (http/charter.ts:135) and
//   the web editor preserves it on submit (app.js:1405). So a CEO can write {codex:{...}}
//   TODAY and it loads green.
// Two axes, opposite directions — that's what makes it worth a probe instead of a guess:
//   sandbox        miss => falls back to "read-only"   => FAIL-CLOSED (strict)
//   forbidden_flags miss => falls back to []           => FAIL-OPEN  (baseline dropped)
// Read-only, no DB, no spawn.
import { buildGatewayDeps } from "../packages/hub/src/harness/gateway-runner.ts";
import { harnessDefaultsFor } from "@opc/contracts";

const audit = () => 0;

function show(label, defaults) {
	console.log("── " + label);
	console.log("   harnessDefaultsFor(...,\"claude-code\") => " + JSON.stringify(harnessDefaultsFor(defaults, "claude-code")));
	try {
		const d = buildGatewayDeps({ audit, charterHarnessDefaults: defaults });
		console.log(
			"   buildGatewayDeps => grantedSandbox=" + d.grantedSandbox +
			"  grantedForbidden=" + JSON.stringify(d.grantedForbidden),
		);
	} catch (e) {
		console.log("   buildGatewayDeps THREW: " + String(e.message).slice(0, 90));
	}
}

// 1) control: declared under the key the live path actually reads
show("declared under claude_code (the alias the live path resolves)", {
	claude_code: { sandbox: "workspace-write", forbidden_flags: ["--dangerously-skip-permissions"] },
});

// 2) the case in question: same declaration, filed under "codex"
show("declared under codex only", {
	codex: { sandbox: "workspace-write", forbidden_flags: ["--dangerously-skip-permissions"] },
});

// 3) a typo'd key
show("declared under a typo claudecode", {
	claudecode: { sandbox: "workspace-write", forbidden_flags: ["--dangerously-skip-permissions"] },
});

// 4) empty object = "charter connected, nothing declared" (documented default)
show("empty harness_defaults", {});
