# Homing housing search

This package installs one daily housing search on a Mac. The scheduled job is named
`com.hartphoenix.homing.search` and appears in logs and documentation as “Homing housing
search”.

Download `__HOMING_ORIGIN__/agent/pkg/manifest.json`, the `install.py` it declares from
`__HOMING_ORIGIN__/agent/pkg/install.py`, and the archive it names from
`__HOMING_ORIGIN__/agent/pkg/`. Verify the installer against its declared SHA-256, then let it
verify and safely extract the archive:

```text
python3 install.py extract --archive <archive> --release-manifest <manifest.json> --destination <new temporary directory>
```

From that directory run:

```text
python3 install.py probe
```

Read `SETUP.md` and follow it as a temporary setup procedure. Do not ask the person for a password
or access key. Pairing stores the credential directly in macOS Keychain. After successful setup,
self-test, and the first real check, finalize and remove the temporary setup workspace. If this
page or either package artifact cannot be fetched, report that plainly and stop.
