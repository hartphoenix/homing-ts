ARG BASE_IMAGE
FROM ${BASE_IMAGE}

RUN useradd --create-home --uid 10001 --shell /bin/sh homing
COPY package /opt/input/package
COPY fixture-ca.pem /opt/fixture/fixture-ca.pem
COPY run.py /opt/scenario/run.py
COPY fake-model.py /opt/scenario/fake-model.py
COPY failure-matrix.py /opt/scenario/failure-matrix.py
COPY entrypoint.sh /opt/scenario/entrypoint.sh
RUN chmod -R go-rwx /opt/input && chmod 0500 /opt/scenario/run.py && \
    chmod 0555 /opt/scenario/entrypoint.sh /opt/scenario/fake-model.py \
      /opt/scenario/failure-matrix.py && \
    chmod 0444 /opt/fixture/fixture-ca.pem

WORKDIR /home/homing
ENTRYPOINT ["/opt/scenario/entrypoint.sh"]
