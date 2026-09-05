---
name: homing-check
description: Run the installed Homing housing search once, inspect status, or remove it.
---

# Homing check

- Run now: `python3 "$HOME/Library/Application Support/Homing Agent/runtime/runner.py" manual`
- Status: `python3 "$HOME/Library/Application Support/Homing Agent/runtime/runner.py" status`
- Remove: `python3 "$HOME/Library/Application Support/Homing Agent/runtime/uninstall.py"`

The scheduled search runs at 09:00 local time or at first wake/login after a missed 09:00,
at most once per local day. Report incomplete, failed, blocked, or pending work exactly; never
turn it into “nothing found”. Never print or inspect the Keychain credential.
