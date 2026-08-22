#!/usr/bin/env python3
"""Adversarial checks for the streamed setup-package extractor."""

import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile


def load_bootstrap(path):
    spec = importlib.util.spec_from_file_location("homing_bootstrap", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, data in entries:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = 0o100600 << 16
            bundle.writestr(info, data)
    return output.getvalue()


def with_archive(manifest, data):
    changed = copy.deepcopy(manifest)
    changed["archive"]["bytes"] = len(data)
    changed["archive"]["sha256"] = hashlib.sha256(data).hexdigest()
    return (json.dumps(changed) + "\n").encode("utf-8")


def refused(module, manifest, data, parent, label):
    before = set(os.listdir(parent))
    try:
        module.safe_extract(manifest, data, parent)
    except SystemExit:
        pass
    else:
        raise AssertionError("unsafe archive case was accepted: " + label)
    if set(os.listdir(parent)) != before:
        raise AssertionError("unsafe archive case left output: " + label)


def main(argv):
    if len(argv) != 4:
        raise SystemExit("usage: bootstrap-safety.py <bootstrap> <manifest> <archive>")
    module = load_bootstrap(argv[1])
    manifest_raw = open(argv[2], "rb").read()
    archive_raw = open(argv[3], "rb").read()
    manifest = json.loads(manifest_raw)
    parent = tempfile.mkdtemp(prefix="homing-bootstrap-test-")
    try:
        good = module.safe_extract(manifest_raw, archive_raw, parent)
        if not os.path.isfile(os.path.join(good, "SETUP.md")):
            raise AssertionError("known-good archive did not materialize")
        shutil.rmtree(good)
        refused(module, manifest_raw, archive_raw[:-7], parent, "truncated")
        replaced = bytearray(archive_raw)
        replaced[len(replaced) // 2] ^= 0x01
        refused(module, manifest_raw, bytes(replaced), parent, "replaced")
        original = []
        with zipfile.ZipFile(io.BytesIO(archive_raw), "r") as bundle:
            for info in bundle.infolist():
                original.append((info.filename, bundle.read(info)))
        omitted = archive(original[1:])
        refused(module, with_archive(manifest, omitted), omitted, parent, "omitted")
        duplicate = archive(original + [original[0]])
        refused(module, with_archive(manifest, duplicate), duplicate, parent, "duplicate")
        escaped_manifest = copy.deepcopy(manifest)
        escaped_manifest["files"].append({
            "path": "../outside-canary", "bytes": 1,
            "sha256": hashlib.sha256(b"x").hexdigest(),
        })
        escaped = archive(original + [("../outside-canary", b"x")])
        refused(module, with_archive(escaped_manifest, escaped), escaped, parent, "path escape")
        if os.path.exists(os.path.join(os.path.dirname(parent), "outside-canary")):
            raise AssertionError("path-escape canary was written")
        print(json.dumps({"status": "PASS", "cases": 5}, sort_keys=True))
    finally:
        shutil.rmtree(parent)


if __name__ == "__main__":
    main(sys.argv)
