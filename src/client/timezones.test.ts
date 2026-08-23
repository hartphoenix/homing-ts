import { describe, expect, it } from "vitest";

import { timezoneLabel, timezoneOptions } from "./timezones";

describe("timezone options", () => {
  it("shows the abbreviation for the current daylight phase", () => {
    expect(timezoneLabel("America/New_York", new Date("2026-08-22T12:00:00Z"))).toContain("EDT");
    expect(timezoneLabel("America/New_York", new Date("2026-12-22T12:00:00Z"))).toContain("EST");
  });

  it("sorts options by their city-first labels", () => {
    const labels = timezoneOptions(new Date("2026-08-22T12:00:00Z")).map(({ label }) => label);
    expect(labels).toEqual(
      [...labels].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" })),
    );
  });
});
