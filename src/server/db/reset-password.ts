import { z } from "zod";

import { closeDatabase, getSqlClient } from "./client";

const emailSchema = z.string().trim().toLowerCase().email().max(254);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("Password reset requires an interactive TTY.");
  }
  process.stdout.write(label);
  const input = process.stdin;
  const previousRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(previousRaw);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("Password reset cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (character >= " " && value.length < 4096) {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

const email = emailSchema.parse(argument("--email"));
const first = await readHidden("New password: ");
const second = await readHidden("Confirm password: ");
if (first !== second) throw new Error("Passwords do not match.");
if (first.length < 12 || first.length > 4096) {
  throw new Error("Password must contain 12 to 4096 characters.");
}

const passwordHash = await Bun.password.hash(first, {
  algorithm: "argon2id",
  memoryCost: 65_536,
  timeCost: 2,
});
const database = getSqlClient();
let updatedCount = 0;
try {
  updatedCount = await database.begin(async (transaction) => {
    const updated = await transaction<{ id: number }[]>`
      update users
         set password_hash = ${passwordHash}, password_reset_required = false, updated_at = now()
       where lower(email) = ${email}
       returning id
    `;
    if (updated.length !== 1 || !updated[0]) {
      throw new Error("No account matched that email.");
    }
    await transaction`delete from sessions where user_id = ${updated[0].id}`;
    await transaction`
      update agent_tokens
         set revoked_at = coalesce(revoked_at, now())
       where user_id = ${updated[0].id}
    `;
    return updated.length;
  });
} finally {
  await closeDatabase();
}
console.log(JSON.stringify({ event: "password_reset_complete", users: updatedCount }));
