#!/usr/bin/env bun

const mode = process.argv[2];
if (mode !== "live" && mode !== "host") {
  throw new Error("usage: test-agentkit-external.ts <live|host> [explicit allow flag]");
}

const requiredFlag = mode === "live" ? "--allow-live-agent" : "--allow-native-host";
const tier = mode === "live" ? "D" : "E";
const missingResource =
  mode === "live"
    ? "disposable agent account, test-only provider credential, and staging Homing account"
    : "clean named OS VM snapshot and test-only external accounts";

if (!process.argv.includes(requiredFlag)) {
  console.log(
    JSON.stringify({
      schema: 1,
      tier,
      status: "SKIP",
      guard: requiredFlag,
      unmet_claim:
        mode === "live" ? "real-agent setup and fresh daily session" : "native release matrix",
      missing_resource: missingResource,
    }),
  );
  process.exit(0);
}

throw new Error(
  `Tier ${tier} remains intentionally unimplemented. ${requiredFlag} grants execution authority; ` +
    `it does not supply ${missingResource}. See tests/agentkit/native/README.md.`,
);
