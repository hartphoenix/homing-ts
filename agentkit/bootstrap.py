#!/usr/bin/env python3
"""Fetch and safely materialize one Homing setup package."""

import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

MAX_ARCHIVE_BYTES = 256 * 1024
MAX_MEMBER_BYTES = 256 * 1024
MAX_MEMBERS = 64


def fail(message):
    raise SystemExit("Homing package refused: " + message)


def fetch_bounded(url, limit):
    request = urllib.request.Request(url, headers={"User-Agent": "homing-agent-kit-bootstrap/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        fail("download exceeded its size limit")
    return data


def clean_member_name(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        fail("archive contains an invalid member name")
    pure = pathlib.PurePosixPath(value)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        fail("archive member escapes the package root: %r" % value)
    return value


def validated_manifest(raw):
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("manifest is not valid UTF-8 JSON")
    if document.get("schema") != 1 or document.get("package") != "homing-agent-kit":
        fail("manifest identity is invalid")
    files = document.get("files")
    archive = document.get("archive")
    if not isinstance(files, list) or not isinstance(archive, dict) or not files:
        fail("manifest shape is invalid")
    if len(files) > MAX_MEMBERS:
        fail("manifest has too many members")
    expected = {}
    for entry in files:
        if not isinstance(entry, dict):
            fail("manifest file entry is invalid")
        name = clean_member_name(entry.get("path"))
        size = entry.get("bytes")
        digest = entry.get("sha256")
        if name in expected:
            fail("manifest repeats member %s" % name)
        if not isinstance(size, int) or size < 0 or size > MAX_MEMBER_BYTES:
            fail("manifest member size is invalid for %s" % name)
        if not isinstance(digest, str) or len(digest) != 64:
            fail("manifest digest is invalid for %s" % name)
        try:
            int(digest, 16)
        except ValueError:
            fail("manifest digest is invalid for %s" % name)
        expected[name] = (size, digest)
    archive_size = archive.get("bytes")
    archive_digest = archive.get("sha256")
    archive_url = archive.get("url")
    if (not isinstance(archive_size, int) or archive_size < 1 or
            archive_size > MAX_ARCHIVE_BYTES):
        fail("archive size is invalid")
    if not isinstance(archive_digest, str) or len(archive_digest) != 64:
        fail("archive digest is invalid")
    try:
        int(archive_digest, 16)
    except ValueError:
        fail("archive digest is invalid")
    if not isinstance(archive_url, str):
        fail("archive URL is invalid")
    return document, expected


def safe_extract(manifest_raw, archive_raw, output_parent):
    document, expected = validated_manifest(manifest_raw)
    archive = document["archive"]
    if len(archive_raw) != archive["bytes"]:
        fail("archive byte count does not match the manifest")
    if hashlib.sha256(archive_raw).hexdigest() != archive["sha256"]:
        fail("archive digest does not match the manifest")

    parent = os.path.realpath(output_parent)
    if not os.path.isdir(parent) or os.path.islink(output_parent):
        fail("output parent is not a regular directory")
    package_root = tempfile.mkdtemp(prefix="homing-agent-kit-", dir=parent)
    try:
        archive_path = os.path.join(package_root, ".download.zip")
        with open(archive_path, "xb") as handle:
            handle.write(archive_raw)
        with zipfile.ZipFile(archive_path, "r") as bundle:
            infos = bundle.infolist()
            names = [clean_member_name(info.filename) for info in infos]
            if len(names) != len(set(names)):
                fail("archive contains duplicate members")
            if set(names) != set(expected):
                fail("archive member set does not match the manifest")
            for info in infos:
                name = info.filename
                mode = (info.external_attr >> 16) & 0xFFFF
                if (info.is_dir() or info.flag_bits & 0x1 or
                        (mode and not stat.S_ISREG(mode))):
                    fail("archive member is not one unencrypted regular file: %s" % name)
                size, digest = expected[name]
                if info.file_size != size or info.file_size > MAX_MEMBER_BYTES:
                    fail("archive member size is invalid for %s" % name)
                data = bundle.read(info)
                if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                    fail("archive member digest is invalid for %s" % name)
                target = os.path.join(package_root, *pathlib.PurePosixPath(name).parts)
                parent_dir = os.path.dirname(target)
                os.makedirs(parent_dir, mode=0o700, exist_ok=True)
                if os.path.commonpath([os.path.realpath(parent_dir), package_root]) != package_root:
                    fail("archive member escaped the package root")
                with open(target, "xb") as handle:
                    handle.write(data)
        os.unlink(archive_path)
        manifest_path = os.path.join(package_root, "manifest.json")
        with open(manifest_path, "xb") as handle:
            handle.write(manifest_raw)
        return package_root
    except BaseException:
        for current, directories, files in os.walk(package_root, topdown=False):
            for name in files:
                os.unlink(os.path.join(current, name))
            for name in directories:
                os.rmdir(os.path.join(current, name))
        os.rmdir(package_root)
        raise


def main(argv):
    if len(argv) != 2:
        fail("usage: bootstrap.py https://homing.example")
    origin = argv[1].rstrip("/")
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        fail("origin must be one HTTPS server URL")
    manifest_raw = fetch_bounded(origin + "/agent/pkg/manifest.json", MAX_ARCHIVE_BYTES)
    document, _expected = validated_manifest(manifest_raw)
    archive_url = document["archive"]["url"]
    archive_parsed = urllib.parse.urlparse(archive_url)
    if (archive_parsed.scheme, archive_parsed.netloc) != (parsed.scheme, parsed.netloc):
        fail("archive URL is not on the manifest origin")
    archive_raw = fetch_bounded(archive_url, MAX_ARCHIVE_BYTES)
    package_root = safe_extract(manifest_raw, archive_raw, tempfile.gettempdir())
    print(package_root)


if __name__ == "__main__":
    main(sys.argv)
