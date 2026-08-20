import { describe, expect, it } from "vitest";

import { redactedPath } from "./logging";

describe("redactedPath", () => {
  it("redacts invitation credentials and object identifiers", () => {
    expect(
      redactedPath(
        "/api/v1/invitations/raw-invitation-token/register/projects/82c2b45b-f341-4d3b-aaad-d3bb61828e56",
      ),
    ).toBe("/api/v1/invitations/:token/register/projects/:id");
  });

  it("does not include query values because it accepts only the parsed path", () => {
    expect(redactedPath("/link/")).toBe("/link/");
  });
});
