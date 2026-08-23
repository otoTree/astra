FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867

ARG ASTRA_H3_RUNTIME_VERSION=0.1.0

ENV ASTRA_H3_RUNTIME_VERSION=${ASTRA_H3_RUNTIME_VERSION} \
    H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED=false \
    H3_WEIGHT_DOWNLOAD_MAX_RETRIES=2 \
    H3_WEIGHT_MANIFEST=/etc/astra/h3/weight-manifest.json \
    H3_WEIGHT_ROOT=/var/lib/astra/h3/weights \
    H3_MODEL_APP_COMMAND_JSON='["python3","/opt/astra/h3/server.py"]' \
    H3_WORKFLOW_TEMPLATE=/opt/astra/h3/workflow_ref2va_api.json \
    H3_EXECUTION_ROOT=/work/executions \
    H3_COMFYUI_INPUT_DIR=/opt/comfyui/input \
    H3_COMFYUI_OUTPUT_DIR=/opt/comfyui/output \
    H3_COMFYUI_URL=http://127.0.0.1:8188 \
    H3_COMFYUI_COMMAND_JSON='[]'

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin astra \
    && install --directory --owner astra --group astra --mode 0700 /var/lib/astra/h3/weights /work /work/executions /opt/comfyui/input /opt/comfyui/output

COPY --chown=astra:astra src/asset_bootstrap.py /opt/astra/h3/asset_bootstrap.py
COPY --chown=astra:astra src/server.py /opt/astra/h3/server.py
COPY --chown=astra:astra workflow_ref2va_api.json /opt/astra/h3/workflow_ref2va_api.json
COPY --chown=astra:astra weight-manifest.json /etc/astra/h3/weight-manifest.json

USER astra
WORKDIR /opt/astra/h3
ENTRYPOINT ["python3", "/opt/astra/h3/asset_bootstrap.py"]
