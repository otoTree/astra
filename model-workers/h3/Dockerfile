FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04

ARG ASTRA_H3_RUNTIME_VERSION=0.1.0

ENV ASTRA_H3_RUNTIME_VERSION=${ASTRA_H3_RUNTIME_VERSION} \
    H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED=false \
    H3_WEIGHT_MANIFEST=/etc/astra/h3/weight-manifest.json \
    H3_WEIGHT_ROOT=/var/lib/astra/h3/weights \
    H3_MODEL_APP_COMMAND_JSON='[]'

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin astra \
    && install --directory --owner astra --group astra --mode 0700 /var/lib/astra/h3/weights /work

COPY --chown=astra:astra src/asset_bootstrap.py /opt/astra/h3/asset_bootstrap.py

USER astra
WORKDIR /opt/astra/h3
ENTRYPOINT ["python3", "/opt/astra/h3/asset_bootstrap.py"]
