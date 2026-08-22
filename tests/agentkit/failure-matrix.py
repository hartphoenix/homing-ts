#!/usr/bin/env python3
"""Exhaust the installer's in-process mutation checkpoints inside /tmp."""

import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

ORIGIN = "https://homing.test"

def load_installer(path):
    spec = importlib.util.spec_from_file_location("homing_agentkit_installer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def package_copy(source, label):
    destination = os.path.join(tempfile.gettempdir(),
                               "homing-agent-kit-matrix-%s-%s" % (label, uuid.uuid4().hex))
    shutil.copytree(source, destination)
    marker = os.path.join(destination, ".homing-agent-kit-ephemeral.json")
    if os.path.lexists(marker):
        os.unlink(marker)
    result = subprocess.run(
        [sys.executable, os.path.join(destination, "scripts", "finalize.py"), "--init",
         "--package-root", destination, "--manifest", os.path.join(destination, "manifest.json")],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        timeout=20)
    if result.returncode:
        raise RuntimeError("fixture package initialization failed: %s" % result.stderr)
    return destination


def remove_tree(path):
    if not os.path.lexists(path):
        return
    for current, dirs, _files in os.walk(path, topdown=False, followlinks=False):
        for name in dirs:
            candidate = os.path.join(current, name)
            if not os.path.islink(candidate):
                try:
                    os.chmod(candidate, 0o700)
                except OSError:
                    pass
        try:
            os.chmod(current, 0o700)
        except OSError:
            pass
    shutil.rmtree(path)
    if os.path.lexists(path):
        raise AssertionError("harness cleanup left %s" % path)


def config(root):
    project = "11111111-1111-4111-8111-111111111111"
    return {
        "schema": 1,
        "origin": ORIGIN,
        "package_version": 3,
        "os": "linux",
        "home": os.path.join(root, "home"),
        "python": sys.executable,
        "worker": {"role": "local", "machine_slug": "failure-matrix"},
        "paths": {
            "config": os.path.join(root, "config"),
            "state": os.path.join(root, "state"),
            "logs": os.path.join(root, "logs"),
            "skill": os.path.join(root, "skills"),
            "extra_skill_dirs": [os.path.join(root, "other-agent-skills")],
        },
        "scheduler": {"kind": "none", "identifier": "homing-check-matrix",
                      "hour": 9, "minute": 37, "cadence_minutes": 1440},
        "secret_store": {"kind": "file", "service": "homing-api-token",
                         "path": os.path.join(root, "credential-store", "token")},
        "runtime": {"kind": "fixture", "invocation_argv": [], "install_skill": True,
                    "skill_flavour": "portable"},
        "isolation_rung": 3,
        "lanes": ["example:sitemap"],
        "sources": {
            "schema": 1,
            "allowed_hosts": ["example.test"],
            "project_prompt_revisions": {project: 1},
            "sources": [{"slug": "example", "lane": "example:sitemap",
                         "url_template": "https://example.test/listings",
                         "permitted_by": "fixture sitemap"}],
        },
    }


def windows_config():
    value = config("C:\\HomingFixture")
    value["os"] = "windows"
    value["home"] = "C:\\Users\\Homing"
    value["python"] = "C:\\Python39\\python.exe"
    value["paths"] = {
        "config": "C:\\Users\\Homing\\AppData\\Local\\Homing\\config",
        "state": "C:\\Users\\Homing\\AppData\\Local\\Homing\\state",
        "logs": "C:\\Users\\Homing\\AppData\\Local\\Homing\\logs",
        "skill": "C:\\Users\\Homing\\.agents\\skills",
    }
    value["secret_store"] = {
        "kind": "dpapi", "service": "homing-api-token",
        "path": "C:\\Users\\Homing\\AppData\\Local\\Homing\\token.dpapi",
    }
    value["runtime"]["invocation_argv"] = [value["python"], "C:\\Fixture\\model.py"]
    return value


def append_command(path, value):
    return [sys.executable, "-c",
            "import sys; f=open(sys.argv[1], 'a'); f.write(sys.argv[2]+'\\n'); "
            "f.flush(); f.close()", path, value]


def add_fixture_scheduler(plan, transcript):
    plan.register_commands = [("fixture register", append_command(transcript, "register"))]
    plan.unregister_commands = [("fixture unregister", append_command(transcript, "unregister"))]
    plan.post_remove_commands = []


def file_entry_count(plan):
    durable = sum(1 for path, _text, _mode in plan.files
                  if path not in plan.create_only or not os.path.exists(path))
    return durable + len(plan.ephemeral_files) + 2


def checkpoints(plan, include_scheduler):
    result = []
    for index, _entry in enumerate(plan.ephemeral_dirs):
        result.extend(("ephemeral-directory:%d:before" % index,
                       "ephemeral-directory:%d:after" % index))
    for index, (path, _mode) in enumerate(plan.dirs):
        if path != plan.bin_dir:
            result.extend(("directory:%d:before" % index,
                           "directory:%d:after" % index))
    result.extend(("bin-directory:before", "bin-directory:after"))
    for index, _entry in enumerate(plan.links):
        result.extend(("link:%d:before" % index, "link:%d:after" % index))
    for index in range(file_entry_count(plan)):
        result.extend(("file:%d:before-backup" % index,
                       "file:%d:before-replace" % index,
                       "file:%d:after-replace" % index))
    result.extend(("bin-mode:before", "bin-mode:after"))
    if include_scheduler:
        for index, _entry in enumerate(plan.register_commands):
            result.extend(("scheduler:%d:before" % index, "scheduler:%d:after" % index))
    if len(result) != len(set(result)):
        raise AssertionError("duplicate mutation checkpoint")
    return result


def snapshot(paths):
    entries = {}
    for root in paths:
        label = os.path.basename(root)
        if not os.path.lexists(root):
            entries[label] = None
            continue
        for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
            names = sorted(dirs + files)
            for name in names:
                path = os.path.join(current, name)
                relative = os.path.relpath(path, root).replace(os.sep, "/")
                info = os.lstat(path)
                key = label + "/" + relative
                if stat.S_ISLNK(info.st_mode):
                    entries[key] = ["link", stat.S_IMODE(info.st_mode), os.readlink(path)]
                    if name in dirs:
                        dirs.remove(name)
                elif stat.S_ISDIR(info.st_mode):
                    entries[key] = ["dir", stat.S_IMODE(info.st_mode)]
                elif stat.S_ISREG(info.st_mode):
                    with open(path, "rb") as handle:
                        digest = hashlib.sha256(handle.read()).hexdigest()
                    entries[key] = ["file", stat.S_IMODE(info.st_mode), digest]
                else:
                    entries[key] = ["other", stat.S_IMODE(info.st_mode)]
    return entries


def durable_paths(root):
    return [os.path.join(root, name) for name in
            ("config", "state", "logs", "skills", "other-agent-skills")]


def assert_no_product(root, setup):
    for path in (os.path.join(root, "config"), os.path.join(root, "state"),
                 os.path.join(root, "logs"), os.path.join(root, "skills", "homing-check"),
                 os.path.join(root, "other-agent-skills", "homing-check")):
        if os.path.lexists(path):
            residue = []
            for current, dirs, files in os.walk(path):
                residue.extend(os.path.join(current, name) for name in sorted(dirs + files))
            raise AssertionError("fresh failure left product residue at %s: %r" %
                                 (path, residue))
    for path in (os.path.join(setup, "connect.sh"), os.path.join(setup, "set-token.sh"),
                 os.path.join(setup, "private")):
        if os.path.lexists(path):
            raise AssertionError("fresh failure left setup residue at %s" % path)
    for current, _dirs, files in os.walk(root):
        for name in files:
            if name.startswith((".homing-backup-", ".homing-write-")):
                raise AssertionError("transaction scratch remains at %s" % current)


def fail_at(module, plan, checkpoint):
    seen = []

    def hook(value):
        seen.append(value)
        if value == checkpoint:
            raise RuntimeError("injected failure at " + value)

    try:
        module.apply_plan(plan, failure_hook=hook)
    except RuntimeError as error:
        if str(error) != "injected failure at " + checkpoint:
            raise
    else:
        raise AssertionError("checkpoint was not reached: %s (saw %s)" % (checkpoint, seen))


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: failure-matrix.py <materialized-package> [origin]")
    global ORIGIN
    if len(sys.argv) == 3:
        ORIGIN = sys.argv[2]
    package_source = os.path.realpath(sys.argv[1])
    package_fresh = package_copy(package_source, "fresh")
    package_install = package_copy(package_source, "install")
    package_repair = package_copy(package_source, "repair")
    module = load_installer(os.path.join(package_fresh, "scripts", "install.py"))
    install_module = load_installer(os.path.join(package_install, "scripts", "install.py"))
    repair_module = load_installer(os.path.join(package_repair, "scripts", "install.py"))
    container = tempfile.mkdtemp(prefix="homing-agentkit-matrix-state-")
    counts = {"fresh": 0, "repair": 0}
    try:
        prototype_root = os.path.join(container, "prototype")
        os.makedirs(os.path.join(prototype_root, "skills"), mode=0o700)
        os.makedirs(os.path.join(prototype_root, "other-agent-skills"), mode=0o700)
        prototype = module.Plan(config(prototype_root), setup_workspace=package_fresh)
        windows = module.Plan(windows_config(), setup_workspace=package_fresh)
        windows_runner = windows.render_runner()
        for name in ("HOMING_TOKEN_STORE", "HOMING_TOKEN_FILE",
                     "HOMING_KEYCHAIN_SERVICE", "CREDENTIALS_DIRECTORY"):
            if ("Remove-Item ('Env:' + $Name)" not in windows_runner or
                    name not in windows_runner):
                raise AssertionError("Windows model environment is not scrubbed")
        transcript = os.path.join(prototype_root, "scheduler-transcript")
        add_fixture_scheduler(prototype, transcript)
        fresh_checkpoints = checkpoints(prototype, include_scheduler=True)

        for index, checkpoint in enumerate(fresh_checkpoints):
            root = os.path.join(container, "fresh-%03d" % index)
            os.makedirs(os.path.join(root, "skills"), mode=0o700)
            os.makedirs(os.path.join(root, "other-agent-skills"), mode=0o700)
            plan = module.Plan(config(root), setup_workspace=package_fresh)
            scheduler_transcript = os.path.join(root, "scheduler-transcript")
            add_fixture_scheduler(plan, scheduler_transcript)
            fail_at(module, plan, checkpoint)
            try:
                assert_no_product(root, package_fresh)
            except AssertionError as error:
                raise AssertionError("%s after %s" % (error, checkpoint))
            lines = []
            if os.path.isfile(scheduler_transcript):
                with open(scheduler_transcript, encoding="utf-8") as handle:
                    lines = handle.read().splitlines()
            expected = ["register", "unregister"] if checkpoint == "scheduler:0:after" else []
            if lines != expected:
                raise AssertionError("scheduler compensation mismatch at %s: %r" %
                                     (checkpoint, lines))
            shutil.rmtree(root)
            counts["fresh"] += 1

        installed_root = os.path.join(container, "installed")
        os.makedirs(os.path.join(installed_root, "skills"), mode=0o700)
        os.makedirs(os.path.join(installed_root, "other-agent-skills"), mode=0o700)
        installed = install_module.Plan(config(installed_root), setup_workspace=package_install)
        install_module.apply_plan(installed)
        manifest = os.path.join(installed_root, "state", "install-manifest.json")
        baseline = snapshot(durable_paths(installed_root))

        repair_prototype = repair_module.repair_plan(manifest, None, None, package_repair)
        repair_checkpoints = checkpoints(repair_prototype, include_scheduler=False)
        for checkpoint in repair_checkpoints:
            repair = repair_module.repair_plan(manifest, None, None, package_repair)
            fail_at(repair_module, repair, checkpoint)
            actual = snapshot(durable_paths(installed_root))
            if actual != baseline:
                raise AssertionError("repair was not byte-identical after %s" % checkpoint)
            counts["repair"] += 1

        print(json.dumps({"schema": 1, "status": "PASS", "checkpoints": counts,
                          "scheduler_compensation": "PASS",
                          "windows_model_environment": "PASS",
                          "repair_byte_identity": "PASS"}, sort_keys=True))
    finally:
        for path in (container, package_fresh, package_install, package_repair):
            remove_tree(path)


if __name__ == "__main__":
    main()
