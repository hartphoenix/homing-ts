import { describe, expect, it } from "vitest";
import { redactedPath } from "../../src/server/logging";

describe("request-log path redaction", () => {
  it("removes invitation tokens, pairing codes, and object identifiers", () => {
    expect(redactedPath("/api/v1/invitations/raw-token-value/accept")).toBe(
      "/api/v1/invitations/:token/accept",
    );
    expect(redactedPath("/api/v1/auth/agent-links/ABC123")).toBe("/api/v1/auth/agent-links/:code");
    expect(redactedPath("/api/v1/projects/11111111-1111-4111-8111-111111111111")).toBe(
      "/api/v1/projects/:id",
    );
  });
});
