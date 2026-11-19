// round331 probe #2: does the new charter-side key check catch BOTH shapes of
// "a harness_defaults cell that no reader ever reaches"?
//
//   arm 1  unrecognized key (typo / unbacked harness)  -> harnessDefaultsFor returns undefined
//   arm 2  same harness written BOTH ways               -> harnessDefaultsFor returns whichever
//                                                         the ALIAS TABLE visits first, i.e. the
//                                                         order the CEO wrote them in is irrelevant
//
// The dangerous direction is the same in both arms and is NOT the sandbox one:
//   sandbox miss        -> falls back to "read-only" (stricter, harmless)
//   forbidden_flags miss-> falls back to []          (the charter's ban silently stops existing)
//
// Read-only, no DB, no spawn. Pure schema + pure functions.
import {
  charterSchema,
  harnessDefaultsFor,
  shadowedHarnessKeys,
  unrecognizedHarnessKeys,
} from "../packages/contracts/src/index.ts";

const BASE = {
  role_id: "test_engineer",
  display_name: "d",
  version: 1,
  honesty_boundaries: ["x"],
  acceptance_criteria: [{ condition: "c", action: "reject", message: "m" }],
  forbidden_actions: [],
  tool_permissions: [],
  model_tier: "execution",
  budget: { daily_usd: 1, per_task_usd: 1 },
  escalation_triggers: [],
  decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
  judgment_mode: {
    type: "bounded_judgment",
    strict_rules: [],
    bounded_judgment: [],
    full_discretion: [],
  },
};

function check(label, defaults) {
  const unknown = unrecognizedHarnessKeys(defaults);
  const shadowed = shadowedHarnessKeys(defaults);
  const winner = harnessDefaultsFor(defaults, "claude-code");
  let load = "OK";
  try {
    charterSchema.parse({ ...BASE, harness_defaults: defaults });
  } catch (e) {
    load = "REJECT";
  }
  console.log("── " + label);
  console.log(
    "   unrecognized=" + JSON.stringify(unknown) +
      "  shadowed=" + JSON.stringify(shadowed),
  );
  console.log("   reader picks for claude-code => " + JSON.stringify(winner));
  console.log("   charterSchema => " + load);
}

check("1 legal single key (control)", {
  claude_code: { sandbox: "workspace-write", forbidden_flags: ["--afk"] },
});
check("2 typo'd key", {
  claudecode: { sandbox: "workspace-write", forbidden_flags: ["--afk"] },
});
check("3 unbacked harness name (codex only)", {
  codex: { sandbox: "workspace-write", forbidden_flags: ["--afk"] },
});
check("4 BOTH spellings of the same harness", {
  "claude-code": { forbidden_flags: ["--afk"] },
  claude_code: { sandbox: "workspace-write" },
});
check("5 two DIFFERENT harnesses (must stay legal)", {
  claude_code: { sandbox: "workspace-write" },
  codex: { sandbox: "read-only" },
});
check("6 no harness_defaults at all", undefined);

// The message has to name the offending key, else the CEO cannot act on it.
try {
  charterSchema.parse({
    ...BASE,
    harness_defaults: { claudecode: { sandbox: "read-only" } },
  });
} catch (e) {
  console.log("\n── message (arm 1)\n" + JSON.stringify(e.issues[0].message, null, 0));
}
try {
  charterSchema.parse({
    ...BASE,
    harness_defaults: { "claude-code": { sandbox: "danger" }, claude_code: { sandbox: "read-only" } },
  });
} catch (e) {
  console.log("\n── message (arm 2)\n" + JSON.stringify(e.issues[0].message, null, 0));
}
