# Homing — agent kit

Homing (`__HOMING_ORIGIN__`) is a housing-search tracker. Its owner keeps search projects, each
holding a written description of the home they are looking for. This page hands you a public
package — the **homing-agent-kit** — that sets up a recurring search and files what it finds into
those projects.

**What you are about to do:** fetch a temporary package, then load `SETUP.md` and follow it
exactly. It is a one-time setup prompt: inspect this environment, connect to the owner's Homing
account without a key passing through the chat, build a small scheduled search, verify it, remove
the temporary package, and report back in plain sentences.

Nothing here is secret. The only secret in this system is the account key, and you never see it.

## Before you ask the person anything

Probe first, ask second. The package ships `scripts/probe.sh` and `scripts/probe.ps1`; one
read-only run answers most setup questions in about fifteen seconds. Then ask **at most three
questions** for the whole setup — one at a time, in plain words, each carrying a default the
person can accept by saying "yes".

Never ask what kind of home they want; their projects already say. Never ask about file paths,
runtimes, models, schedulers, or where to keep secrets — decide those and state what you picked.
Never ask for a password or an access key, and never accept one pasted into the chat.

If you cannot fetch this package at all: say so plainly and stop. Do not improvise an integration
against an API you have not read.

## Get the package

Take the first row you can actually perform.

| What you have | Ladder |
|---|---|
| A shell, plus one of `curl` `wget` `python3` `node` `bun` `powershell` | **A — byte-exact** |
| A fetch tool and the ability to write files, but no shell | **B — file by file** |
| Only a fetch tool that hands you converted text (WebFetch and the like) | **C — read in place** |
| No way to fetch a URL | Tell the person: "Open `__HOMING_ORIGIN__/agent/` yourself and paste me what it says." Then stop. |

Every ladder starts from the same index, `__HOMING_ORIGIN__/agent/pkg/manifest.json`. It lists
`path`, `bytes`, `lines`, `sha256`, `first_line` and `last_line` for every file, an `archive`
block holding the zip URL and its digest, the package `version`, and `min_runtime_version`.

### Ladder A — byte-exact

1. Stream `GET __HOMING_ORIGIN__/agent/bootstrap.py` into Python 3.9+ and give it the single
   argument `__HOMING_ORIGIN__`. Do not save it in a skill or durable resource.
2. The bootstrap fetches the manifest and archive itself. It authenticates the complete archive
   bytes before opening it, then rejects absolute, parent, duplicate, encrypted, linked, special,
   oversized, missing, or extra members before writing any package member.
3. Capture its one stdout line: the new verified temporary directory whose name starts with
   `homing-agent-kit-`. Any error means stop and report; never fall back to a generic unzip tool.
4. Run `scripts/finalize.py --help`, then initialize this exact verified workspace with its
   `--init` form. Keep all setup-only scratch files inside it. `SETUP.md` removes it after the
   completed self-test and first real check.

### Ladder B — file by file

Fetch `__HOMING_ORIGIN__/agent/pkg/<path>` for each entry in `files` and write it. Verify by
sha256 if you can compute one; otherwise verify structurally as in Ladder C. A mismatch stops the
setup the same way. Keep every downloaded file in one temporary directory named
`homing-agent-kit-*`. After setup succeeds, delete every file listed by the manifest, the saved
manifest, and that directory. If the file-writing tool cannot remove them, report the remaining
directory instead of claiming cleanup succeeded.

### Ladder C — read in place

Your fetcher converts pages to markdown with a small model, so what reaches you is a paraphrase of
the file, not the file. Three consequences, none negotiable:

- **Never checksum what you received.** It will not match, on whitespace alone. Verify
  structurally: the line count equals `lines`, the first line equals `first_line`, the last line
  equals `last_line`. If a document fails that, refetch it once, then stop and report.
- **Code arrives mangled** — fences dropped, indentation flattened, lines reordered, separators
  invented. Do not write anything from `scripts/` to disk on this ladder and do not run it. Those
  files do not exist for you; skip them.
- **Hold the prose in context** instead of saving it. Paraphrase is tolerable for instructions,
  which is all you are getting.

Fetch in this order, and only as far as the procedure actually takes you:

1. `pkg/SETUP.md` — always, first.
2. `pkg/references/probe.md` — Phase 1.
3. `pkg/references/pairing.md` — Phase 2.
4. `pkg/references/sources.md`, then `pkg/references/reachability.md` — Phase 4.
5. `pkg/references/environments.md`, then `pkg/references/security.md` — Phase 5.
6. `pkg/references/runtime-template.md` — Phase 7.
7. `pkg/references/troubleshooting.md` — only when something has failed.

No shell means no probe script, no scheduler, and no generated files. That is a supported outcome,
not a failure: `SETUP.md` routes you to connect the account and then to run the search yourself
whenever the person asks. The fetched prose remains only in this conversation's context; do not
persist it as a skill or resource. Say so plainly rather than implying a schedule exists.

## Then

Load `SETUP.md` and follow it in order from Phase 0. Do not skip Phase 1.

`__HOMING_ORIGIN__/agent/pkg/VERSION` holds one integer. A higher number than the installed one
means a newer package exists; only a person starting a fresh setup may act on that. A scheduled
run never upgrades itself.

## If you are a person reading this

This page is written for the assistant you asked to set up your Homing search — you need nothing
from it. Copy the short instruction from Homing's setup page, paste it to your assistant, and it
takes over from here.

The only thing it should ever ask you to do with your account is open a link and press Approve on
a six-character code matching the one it shows you. It should never ask for your password, and
never ask you to paste a key into the chat. If it does, something is wrong — stop and tell us.
