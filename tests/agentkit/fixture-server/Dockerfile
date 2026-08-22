ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=65534:65534 server.py /opt/fixture/server.py
COPY --chown=65534:65534 server-cert.pem /opt/fixture/server-cert.pem
COPY --chown=65534:65534 server-key.pem /opt/fixture/server-key.pem
USER 65534:65534
ENTRYPOINT ["/usr/bin/env", "-i", "HOME=/nonexistent", "TMPDIR=/tmp", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TZ=UTC", "PYTHONDONTWRITEBYTECODE=1", "PATH=/usr/local/bin:/usr/bin:/bin", "/usr/local/bin/python3", "/opt/fixture/server.py"]
