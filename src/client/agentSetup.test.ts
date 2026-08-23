import { describe, expect, it } from "vitest";

import { buildAgentSetupPrompt } from "./agentSetup";

describe("buildAgentSetupPrompt", () => {
  it("directs the agent to the current deployment without carrying a secret", () => {
    const prompt = buildAgentSetupPrompt("https://homing.example.test/");

    expect(prompt).toContain("Read https://homing.example.test/agent/ and follow it exactly.");
    expect(prompt).toContain("Never put a password or an access key into this chat.");
    expect(prompt).not.toContain("/api/");
    expect(prompt.length).toBeLessThanOrEqual(1000);
  });
});
