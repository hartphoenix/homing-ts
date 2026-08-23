export type TimezoneOption = {
  label: string;
  value: string;
};

function timezoneName(timezone: string, date: Date): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find(({ type }) => type === "timeZoneName");
  return part?.value ?? timezone;
}

function timezoneCity(timezone: string): string {
  if (timezone === "UTC") return "UTC";
  return (timezone.split("/").at(-1) ?? timezone).replaceAll("_", " ");
}

export function timezoneLabel(timezone: string, date = new Date()): string {
  const city = timezoneCity(timezone);
  const abbreviation = timezoneName(timezone, date);
  return city === abbreviation
    ? `${city} (${timezone})`
    : `${city} — ${abbreviation} (${timezone})`;
}

export function detectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timezoneOptions(date = new Date()): TimezoneOption[] {
  const supported = Intl.supportedValuesOf("timeZone");
  const timezones = supported.includes("UTC") ? supported : ["UTC", ...supported];
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  return timezones
    .map((value) => ({ value, label: timezoneLabel(value, date) }))
    .sort((left, right) => collator.compare(left.label, right.label));
}
