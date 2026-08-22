#!/bin/sh
set -eu

exec /usr/bin/env -i \
  HOME=/home/homing \
  USER=homing \
  LOGNAME=homing \
  TMPDIR=/tmp \
  XDG_CONFIG_HOME=/home/homing/.config \
  XDG_STATE_HOME=/home/homing/.local/state \
  XDG_CACHE_HOME=/home/homing/.cache \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  TZ=UTC \
  PYTHONDONTWRITEBYTECODE=1 \
  SSL_CERT_FILE=/opt/fixture/fixture-ca.pem \
  PATH=/usr/local/bin:/usr/bin:/bin \
  HOMING_HARNESS_HOST_CANARY="${HOMING_HARNESS_HOST_CANARY:?}" \
  HOMING_HARNESS_TARGET_CANARY="${HOMING_HARNESS_TARGET_CANARY:?}" \
  /usr/local/bin/python3 /opt/scenario/run.py
