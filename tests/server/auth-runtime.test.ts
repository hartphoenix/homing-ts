import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const pbkdf2Fixture = "pbkdf2_sha256$260000$known-salt$VgacIdGkvu2udMuuojgq5qqZphxnf+nAQ/gA83qSwkI";
const argon2Fixture =
  "argon2$argon2id$v=19$m=8192,t=2,p=1$1Jx3YF0EKyZ0vaqZN+vpgtErMtZ9vH5edF2WDr6AJz0$bFMRVvuFxhg1K5hnHwJC/7ayARmxWc9OAyo9jfTd9hM";

describe("Bun password runtime compatibility", () => {
  it("verifies correct and wrong fixed Django Argon2 and PBKDF2 fixtures", () => {
    const program = `
      import { verifyImportedPassword } from "./src/server/auth/password.ts";
      const argon = ${JSON.stringify(argon2Fixture)};
      const pbkdf2 = ${JSON.stringify(pbkdf2Fixture)};
      const results = {
        argonCorrect: await verifyImportedPassword("Correct Horse Battery Staple", argon),
        argonWrong: await verifyImportedPassword("wrong", argon),
        pbkdf2Correct: await verifyImportedPassword("fixture password", pbkdf2),
        pbkdf2Wrong: await verifyImportedPassword("wrong", pbkdf2),
      };
      console.log(JSON.stringify(results));
    `;
    const output = execFileSync("bun", ["-e", program], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(output) as Record<string, { valid: boolean; rehash?: string }>;
    expect(result.argonCorrect).toMatchObject({ valid: true });
    expect(result.argonCorrect?.rehash).toMatch(/^\$argon2id\$/);
    expect(result.argonWrong).toEqual({ valid: false });
    expect(result.pbkdf2Correct).toMatchObject({ valid: true });
    expect(result.pbkdf2Correct?.rehash).toMatch(/^\$argon2id\$/);
    expect(result.pbkdf2Wrong).toEqual({ valid: false });
  });
});
