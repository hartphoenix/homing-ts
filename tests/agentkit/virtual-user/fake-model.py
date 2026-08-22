#!/usr/bin/env python3
"""Strict deterministic model boundary used only in the contained persona."""

import hashlib
import json
import os
import sys


HOME = os.environ.get("HOMING_FIXTURE_HOME", "")
if (not HOME.startswith("/home/homing/case-") or not os.path.isdir(HOME) or
        len(sys.argv) != 1 or os.path.realpath(os.getcwd()) != os.path.realpath(HOME)):
    raise SystemExit("unexpected model invocation boundary")
JUDGE = os.path.join(HOME, ".config", "homing", "prompts", "JUDGE.md")
WORK = os.path.join(HOME, ".local", "state", "homing", "work")
stdin = sys.stdin.buffer.read()
with open(JUDGE, "rb") as handle:
    expected = handle.read()
if stdin != expected:
    raise SystemExit("stdin is not the installed JUDGE.md")

credential_environment = sorted(name for name in os.environ
                                if name.startswith("HOMING_TOKEN") or
                                name in ("HOMING_KEYCHAIN_SERVICE", "CREDENTIALS_DIRECTORY"))
setup_markers = []
for name in ("SET" + "UP.md", "inst" + "all.py", "final" + "ize.py",
             "pro" + "be.sh", "homing-" + "setup"):
    for path in (JUDGE, os.path.join(WORK, "prompt.txt"),
                 os.path.join(WORK, "candidates.jsonl")):
        if os.path.isfile(path):
            with open(path, "rb") as handle:
                if name.encode() in handle.read():
                    setup_markers.append(name)
for required in (os.path.join(WORK, "prompt.txt"), os.path.join(WORK, "candidates.jsonl")):
    if not os.path.isfile(required):
        raise SystemExit("required model input is missing")

setup_paths_accessible = []
for path in ["/opt/input/package"] + [
        os.path.join("/tmp", name) for name in os.listdir("/tmp")
        if name.startswith("homing-agent-kit-")]:
    try:
        os.listdir(path)
        setup_paths_accessible.append(path)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        pass

scores = []
candidates = os.path.join(WORK, "candidates.jsonl")
if os.path.isfile(candidates):
    with open(candidates, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith("{"):
                continue
            row = json.loads(line)
            scores.append({"id": row["id"], "keep": True, "score": 80,
                           "summary": "fixture match", "suspected_injection": False})
with open(os.path.join(WORK, "scored.jsonl"), "w", encoding="utf-8") as handle:
    for score in scores:
        handle.write(json.dumps(score, sort_keys=True) + "\n")
with open(os.path.join(HOME, "model-transcript.json"), "w", encoding="utf-8") as handle:
    json.dump({"stdin_sha256": hashlib.sha256(stdin).hexdigest(),
               "credential_environment": credential_environment,
               "setup_markers": sorted(set(setup_markers)),
               "setup_paths_accessible": sorted(set(setup_paths_accessible)),
               "candidate_count": len(scores), "pid": os.getpid()}, handle, sort_keys=True)
    handle.write("\n")
if credential_environment or setup_markers or setup_paths_accessible:
    raise SystemExit("model boundary violation")
