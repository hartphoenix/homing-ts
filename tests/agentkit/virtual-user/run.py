#!/usr/bin/env python3
"""Contained nontechnical-user lifecycle. Standard library only."""

import json
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


ORIGIN = "https://homing.test:8443"
PROJECT = "11111111-1111-4111-8111-111111111111"
SOURCE = "https://source.test:8443/listings.xml"
PACKAGE_SOURCE = "/opt/input/package"
TARGET_UID = 10001
TARGET_GID = 10001
EXPECTED_ENVIRONMENT = {
    "HOME", "USER", "LOGNAME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
    "XDG_CACHE_HOME", "LANG", "LC_ALL", "TZ", "PYTHONDONTWRITEBYTECODE",
    "SSL_CERT_FILE", "PATH", "HOMING_HARNESS_HOST_CANARY", "HOMING_HARNESS_TARGET_CANARY",
}


def demote():
    os.setgroups([])
    os.setgid(TARGET_GID)
    os.setuid(TARGET_UID)


def run(argv, expected=0, env=None, home=None):
    child_environment = dict(env or os.environ)
    child_environment.pop("HOMING_HARNESS_HOST_CANARY", None)
    child_environment.pop("HOMING_HARNESS_TARGET_CANARY", None)
    if home:
        child_environment.update({
            "HOME": home,
            "XDG_CONFIG_HOME": os.path.join(home, ".config"),
            "XDG_STATE_HOME": os.path.join(home, ".local", "state"),
            "XDG_CACHE_HOME": os.path.join(home, ".cache"),
        })
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, timeout=30,
                            preexec_fn=demote, env=child_environment, cwd=home)
    if expected is not None and result.returncode != expected:
        detail = (result.stdout + "\n" + result.stderr).strip()
        raise RuntimeError("command failed (%s): %s" % (result.returncode, detail[-4000:]))
    return result


def package_copy(label):
    root = tempfile.mkdtemp(prefix="homing-agent-kit-%s-" % label)
    shutil.rmtree(root)
    shutil.copytree(PACKAGE_SOURCE, root)
    for current, directories, files in os.walk(root):
        os.chown(current, TARGET_UID, TARGET_GID)
        for name in directories + files:
            os.chown(os.path.join(current, name), TARGET_UID, TARGET_GID)
    return root


def initialize(root, home=None):
    finalizer = os.path.join(root, "scripts", "finalize.py")
    manifest = os.path.join(root, "manifest.json")
    run([sys.executable, finalizer, "--init", "--package-root", root,
         "--manifest", manifest], home=home)
    return finalizer, manifest


def plan(home, install_skill, runtime=True):
    invocation = [sys.executable, "/opt/scenario/fake-model.py"] if runtime else []
    return {
        "schema": 1,
        "origin": ORIGIN,
        "package_version": 3,
        "os": "linux",
        "home": home,
        "python": sys.executable,
        "worker": {"role": "local", "machine_slug": "ordinary-laptop"},
        "paths": {
            "config": os.path.join(home, ".config", "homing"),
            "state": os.path.join(home, ".local", "state", "homing"),
            "logs": os.path.join(home, ".local", "state", "homing-logs"),
            "skill": os.path.join(home, ".agents", "skills"),
        },
        "scheduler": {"kind": "none", "identifier": "homing-check-fixture",
                      "hour": 9, "minute": 37, "cadence_minutes": 1440},
        "secret_store": {"kind": "file", "service": "homing-api-token",
                         "path": os.path.join(home, ".local", "state", "fixture-token")},
        "runtime": {"kind": "fixture-model", "invocation_argv": invocation,
                    "install_skill": install_skill, "skill_flavour": "portable"},
        "isolation_rung": 3,
        "lanes": ["fixture:sitemap"],
        "sources": {
            "schema": 1,
            "allowed_hosts": ["source.test"],
            "project_prompt_revisions": {PROJECT: 1},
            "sources": [{
                "slug": "fixture", "tier": "sanctioned", "channel": "sitemap",
                "lane": "fixture:sitemap", "url_template": SOURCE,
                "permitted_by": "fixture robots allowance", "id_rule": "path_segment:-1",
                "lastmod_path": "sitemap:lastmod",
                "listing_url_pattern": r"^https://source\.test:8443/listing/[a-z0-9-]+$",
                "fingerprint": {"shell_markers": [], "listing_selector": "",
                                "min_ok_bytes": 20},
                "rate": {"min_interval_ms": 1, "max_concurrency": 1},
            }],
        },
    }


def write_json(path, value):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    os.chown(path, TARGET_UID, TARGET_GID)


def assert_uninstall_refused(script, manifest_path, replacement, home):
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    tampered = json.loads(json.dumps(manifest))
    owned = next(entry for entry in tampered["owned_dirs"] if entry["role"] == "config")
    owned["path"] = replacement
    owned["marker"] = os.path.join(replacement, ".homing-install-owner.json")
    path = os.path.join(os.environ["HOME"], "tampered-%s.json" % uuid.uuid4().hex)
    write_json(path, tampered)
    refused = subprocess.run(
        [sys.executable, script, "--uninstall", "--manifest", path, "--purge-logs"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=30, preexec_fn=demote, cwd=home,
        env={**os.environ, "HOME": home,
             "XDG_CONFIG_HOME": os.path.join(home, ".config"),
             "XDG_STATE_HOME": os.path.join(home, ".local", "state"),
             "XDG_CACHE_HOME": os.path.join(home, ".cache")})
    os.unlink(path)
    if refused.returncode == 0:
        raise RuntimeError("uninstall accepted protected root %s" % replacement)


def install(package, home, install_skill):
    config = os.path.join(home, "plan-%s.json" % uuid.uuid4().hex)
    write_json(config, plan(home, install_skill))
    script = os.path.join(package, "scripts", "install.py")
    run([sys.executable, script, "--config", config, "--setup-workspace", package], home=home)
    os.unlink(config)
    state = os.path.join(home, ".local", "state", "homing")
    return script, os.path.join(state, "install-manifest.json")


def assert_durable_boundary(package, manifest_path, home, install_skill):
    config = os.path.join(home, ".config", "homing")
    assert not os.path.exists(os.path.join(config, "connect.sh"))
    assert not os.path.exists(os.path.join(config, "set-token.sh"))
    assert os.path.isfile(os.path.join(package, "connect.sh"))
    assert os.path.isfile(os.path.join(package, "set-token.sh"))
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    rendered = json.dumps(manifest)
    for forbidden in ("SETUP.md", "finalize.py", "probe.sh", "connect.sh", "set-token.sh"):
        assert forbidden not in rendered
    skill = os.path.join(home, ".agents", "skills", "homing-check", "SKILL.md")
    assert os.path.isfile(skill) is install_skill
    owned_roots = [entry["path"] for entry in manifest.get("owned_dirs", [])]
    allowed_files = {entry["path"] for entry in manifest.get("files", [])}
    allowed_files.update({manifest_path, os.path.join(os.path.dirname(manifest_path),
                                                      "UNINSTALL.md")})
    allowed_links = {entry["path"] for entry in manifest.get("links", [])}
    actual = set()
    for owned_root in owned_roots:
        for current, directories, files in os.walk(owned_root, followlinks=False):
            for name in list(directories):
                path = os.path.join(current, name)
                if os.path.islink(path):
                    actual.add(path)
                    directories.remove(name)
            actual.update(os.path.join(current, name) for name in files)
    unknown = sorted(actual - allowed_files - allowed_links)
    if unknown:
        raise RuntimeError("durable install contains unrecorded files: %r" % unknown)


def fake_model_script():
    path = "/opt/scenario/fake-model.py"
    # The image root is read-only at runtime. The script is supplied by the image
    # builder beside this runner, so only validate it here.
    if not os.path.isfile(path):
        raise RuntimeError("fake model is missing")
    return path


def selftest(package, manifest, home):
    run([sys.executable, os.path.join(package, "scripts", "selftest.py"),
         "--manifest", manifest, "--offline", "--no-secret-read", "--json"], home=home)


def finalize(package, finalizer, public_manifest, installed_manifest, home):
    run([sys.executable, finalizer, "--finalize", "--package-root", package,
         "--manifest", public_manifest, "--installed-manifest", installed_manifest], home=home)
    assert not os.path.exists(package)


def daily(manifest, home):
    with open(manifest, encoding="utf-8") as handle:
        runner = json.load(handle)["runner"]
    os.environ["HOMING_FIXTURE_HOME"] = home
    try:
        result = run(["/bin/sh", runner], expected=None, home=home)
    finally:
        os.environ.pop("HOMING_FIXTURE_HOME", None)
    if result.returncode != 0:
        logs = os.path.join(home, ".local", "state", "homing-logs")
        details = []
        if os.path.isdir(logs):
            for name in sorted(os.listdir(logs))[-3:]:
                path = os.path.join(logs, name)
                if os.path.isfile(path):
                    with open(path, encoding="utf-8", errors="replace") as handle:
                        details.append(handle.read()[-4000:])
        raise RuntimeError("daily runner failed (%s): %s" %
                           (result.returncode, "\n".join(details)[-4000:]))
    state = os.path.dirname(manifest)
    with open(os.path.join(state, "last-run.json"), encoding="utf-8") as handle:
        outcome = json.load(handle)
    assert outcome.get("ok") is True
    return outcome


def create_case_home(label):
    home = os.path.join(os.environ["HOME"], "case-" + label)
    os.makedirs(home, mode=0o700)
    os.chown(home, TARGET_UID, TARGET_GID)
    token = os.path.join(home, ".local", "state", "fixture-token")
    code = ("import os,sys; p=sys.argv[1]; os.makedirs(os.path.dirname(p),mode=0o700,"
            "exist_ok=True); open(p,'w').write('fixture-only-token'); os.chmod(p,0o600)")
    run([sys.executable, "-c", code, token], home=home)
    canary = os.path.join(home, "Downloads", "fixture-target-canary.txt")
    os.makedirs(os.path.dirname(canary), mode=0o700, exist_ok=True)
    with open(canary, "w", encoding="utf-8") as handle:
        handle.write(os.environ["HOMING_HARNESS_TARGET_CANARY"])
    os.chown(os.path.dirname(canary), TARGET_UID, TARGET_GID)
    os.chown(canary, TARGET_UID, TARGET_GID)
    return home


def calibrate_target(home):
    script = """
import json,locale,os,platform,ssl,tempfile,time,urllib.request
assert os.getuid() == 10001 and os.getgid() == 10001
assert os.path.realpath(os.path.expanduser('~')) == os.path.realpath(os.environ['HOME'])
assert os.path.realpath(os.getcwd()) == os.path.realpath(os.environ['HOME'])
assert os.path.realpath(tempfile.gettempdir()) == '/tmp'
with urllib.request.urlopen('https://homing.test:8443/health', timeout=5,
                            context=ssl.create_default_context()) as response:
    assert response.status == 200 and json.load(response).get('ok') is True
print(json.dumps({'uid':os.getuid(),'python':platform.python_version(),
                  'architecture':platform.machine(),'locale':locale.setlocale(locale.LC_CTYPE),
                  'timezone':time.tzname[0],'tls':'PASS'}))
"""
    result = run([sys.executable, "-c", script], home=home)
    report = json.loads(result.stdout)
    if report.get("tls") != "PASS" or not str(report.get("python", "")).startswith("3."):
        raise RuntimeError("target calibration returned an invalid report")
    return report


def assert_no_host_canary(home):
    needle = os.environ["HOMING_HARNESS_HOST_CANARY"].encode("utf-8")
    for current, _directories, files in os.walk(home, followlinks=False):
        for name in files:
            path = os.path.join(current, name)
            try:
                with open(path, "rb") as handle:
                    if needle in handle.read(1024 * 1024 + 1):
                        raise RuntimeError("host canary leaked into target file: %s" % path)
            except OSError:
                continue


def product_residue(home):
    residue = []
    for current, directories, files in os.walk(home, followlinks=False):
        for name in directories + files:
            path = os.path.join(current, name)
            if name in (".homing-install-owner.json", "install-manifest.json", "homing-setup"):
                residue.append(path)
    return sorted(residue)


def all_files(home):
    result = []
    for current, directories, files in os.walk(home, followlinks=False):
        for name in list(directories):
            path = os.path.join(current, name)
            if os.path.islink(path):
                result.append(path)
                directories.remove(name)
        result.extend(os.path.join(current, name) for name in files)
    return sorted(result)


def remove_case(home):
    run([sys.executable, "-c", "import shutil,sys; shutil.rmtree(sys.argv[1])", home])


def first_time_probe():
    home = create_case_home("first-time")
    package = package_copy("first-time")
    finalizer, manifest = initialize(package, home)
    environment = dict(os.environ)
    environment["HOME"] = home
    environment["PATH"] = "/usr/bin:/bin"
    probed = run(["/bin/sh", os.path.join(package, "scripts", "probe.sh")],
                 env=environment, home=home)
    report = json.loads(probed.stdout)
    tools = {entry["name"]: entry["state"] for entry in report.get("tools", [])}
    if tools.get("python3") != "absent" or report.get("capabilities", {}).get("shell") != "have":
        raise RuntimeError("first-time persona did not report missing Python accurately")
    run([sys.executable, finalizer, "--discard", "--package-root", package,
         "--manifest", manifest], home=home)
    if product_residue(home):
        raise RuntimeError("first-time probe mutated Homing product state")
    remove_case(home)
    return {"python3": "absent", "probe": "PASS", "product_residue": "PASS"}


def lifecycle(label, install_skill):
    home = create_case_home(label)
    calibration = calibrate_target(home)
    package_a = package_copy(label + "-a")
    finalizer_a, public_a = initialize(package_a, home)
    _install_script, installed = install(package_a, home, install_skill)
    assert_durable_boundary(package_a, installed, home, install_skill)
    selftest(package_a, installed, home)
    finalize(package_a, finalizer_a, public_a, installed, home)
    first = daily(installed, home)
    second = daily(installed, home)

    package_b = package_copy(label + "-b")
    finalizer_b, public_b = initialize(package_b, home)
    repair = os.path.join(package_b, "scripts", "install.py")
    run([sys.executable, repair, "--repair", "--manifest", installed,
         "--setup-workspace", package_b, "--dry-run"], home=home)
    run([sys.executable, repair, "--repair", "--manifest", installed,
         "--setup-workspace", package_b], home=home)
    selftest(package_b, installed, home)
    finalize(package_b, finalizer_b, public_b, installed, home)
    third = daily(installed, home)

    package_c = package_copy(label + "-c")
    finalizer_c, public_c = initialize(package_c, home)
    uninstall = os.path.join(package_c, "scripts", "install.py")
    assert_uninstall_refused(uninstall, installed, "/", home)
    assert_uninstall_refused(uninstall, installed, home, home)
    assert os.path.isfile(os.path.join(home, ".config", "homing", "bin", "run.sh"))

    foreign = []
    for directory in (os.path.join(home, ".config", "homing"),
                      os.path.join(home, ".local", "state", "homing")):
        path = os.path.join(directory, "foreign.txt")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("foreign")
        os.chown(path, TARGET_UID, TARGET_GID)
        foreign.append(path)
    if install_skill:
        directory = os.path.join(home, ".agents", "skills", "homing-check")
        path = os.path.join(directory, "foreign.txt")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("foreign")
        os.chown(path, TARGET_UID, TARGET_GID)
        foreign.append(path)

    run([sys.executable, uninstall, "--uninstall", "--manifest", installed, "--purge-logs"],
        home=home)
    assert all(os.path.isfile(path) for path in foreign)
    run([sys.executable, finalizer_c, "--discard", "--package-root", package_c,
         "--manifest", public_c], home=home)
    residue = product_residue(home)
    if residue:
        raise RuntimeError("owned product residue remains: %r" % residue)
    assert_no_host_canary(home)

    transcript = os.path.join(home, "model-transcript.json")
    assert os.path.isfile(transcript)
    with open(transcript, encoding="utf-8") as handle:
        model = json.load(handle)
    assert model["setup_markers"] == []
    assert model["credential_environment"] == []
    assert model["setup_paths_accessible"] == []
    allowed_after_uninstall = set(foreign + [
        transcript,
        os.path.join(home, "Downloads", "fixture-target-canary.txt"),
    ])
    unexpected = sorted(set(all_files(home)) - allowed_after_uninstall)
    if unexpected:
        raise RuntimeError("uninstall left files outside the foreign allowlist: %r" % unexpected)
    with open(transcript, "rb") as handle:
        transcript_digest = hashlib.sha256(handle.read()).hexdigest()
    remove_case(home)
    return {
        "install_skill": install_skill,
        "daily_summaries": [first.get("summary"), second.get("summary"), third.get("summary")],
        "model_transcript_sha256": transcript_digest,
        "product_residue": "PASS",
        "calibration": calibration,
    }


def main():
    started = time.monotonic()
    assert set(os.environ) == EXPECTED_ENVIRONMENT, sorted(os.environ)
    fake_model_script()
    home = os.environ["HOME"]
    os.makedirs(os.path.join(home, "Downloads", "Homing setup – O'Neil"), exist_ok=True)
    os.chown(os.path.join(home, "Downloads"), TARGET_UID, TARGET_GID)
    os.chown(os.path.join(home, "Downloads", "Homing setup – O'Neil"), TARGET_UID, TARGET_GID)

    first_time = first_time_probe()
    matrix_package = package_copy("matrix")
    matrix_finalizer, matrix_manifest = initialize(matrix_package)
    matrix = run([sys.executable, "/opt/scenario/failure-matrix.py", matrix_package, ORIGIN])
    matrix_report = json.loads(matrix.stdout.strip().splitlines()[-1])
    run([sys.executable, matrix_finalizer, "--discard", "--package-root", matrix_package,
         "--manifest", matrix_manifest])

    cases = [lifecycle("scheduler-only", False), lifecycle("with-skill", True)]
    leftovers = [name for name in os.listdir(tempfile.gettempdir())
                 if name.startswith("homing-agent-kit-")]
    assert not leftovers, leftovers

    with open(os.path.join(PACKAGE_SOURCE, "manifest.json"), "rb") as handle:
        artifact_digest = hashlib.sha256(handle.read()).hexdigest()

    print(json.dumps({
        "schema": 1,
        "tier": "C",
        "persona": "equipped-user",
        "python": platform.python_version(),
        "architecture": platform.machine(),
        "containment": "linux-container",
        "network": "internal-fixture-only",
        "locale": os.environ.get("LC_ALL", ""),
        "timezone": os.environ.get("TZ", ""),
        "allowed_environment_names": sorted(os.environ),
        "tool_inventory": {"python": platform.python_version(), "shell": "/bin/sh"},
        "product": "PASS",
        "product_residue": "PASS",
        "cleanup_provenance": ["product"],
        "artifact_manifest_sha256": artifact_digest,
        "setup_and_daily_processes_distinct": True,
        "setup_source_access": "REFUSED_BY_UID_BOUNDARY",
        "failure_matrix": matrix_report,
        "first_time_user": first_time,
        "cases": cases,
        "duration_ms": int((time.monotonic() - started) * 1000),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
