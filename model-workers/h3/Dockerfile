FROM oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a AS bun-runtime

FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867

ARG ASTRA_H3_RUNTIME_VERSION=0.2.0
ARG ASTRA_TORCH_VERSION=2.9.1
ARG ASTRA_TORCHVISION_VERSION=0.24.1
ARG ASTRA_TORCHAUDIO_VERSION=2.9.1

ENV DEBIAN_FRONTEND=noninteractive

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
    H3_COMFYUI_COMMAND_JSON='["python3","/opt/comfyui/main.py","--listen","127.0.0.1","--port","8188","--extra-model-paths-config","/opt/comfyui/extra_model_paths.yaml"]' \
    H3_BUILD_COMFYUI_ROOT=/opt/comfyui \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:/usr/local/bin:${PATH}

RUN apt-get update \
    && apt-get install --no-install-recommends --yes bash ca-certificates curl ffmpeg git libgcc-s1 libstdc++6 python3 python3-dev python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin astra \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip==25.3 \
    && install --directory --owner astra --group astra --mode 0700 /var/lib/astra/h3/weights /work /work/executions /work/tasks /opt/comfyui/input /opt/comfyui/output

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /opt/astra
COPY package.json bun.lock bunfig.toml tsconfig.base.json tsconfig.json ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages
COPY model-workers ./model-workers
RUN bun install --frozen-lockfile && bun --version

COPY --from=thirdparty ComfyUI /opt/comfyui
COPY --from=thirdparty ComfyUI-H3-FaceRefine /opt/comfyui/custom_nodes/ComfyUI-H3-FaceRefine
COPY --from=thirdparty ComfyUI-KJNodes /opt/comfyui/custom_nodes/ComfyUI-KJNodes
COPY --from=thirdparty ComfyUI-VideoHelperSuite /opt/comfyui/custom_nodes/ComfyUI-VideoHelperSuite
COPY --from=thirdparty comfyui-minimax-h3-audio-T8 /opt/comfyui/custom_nodes/comfyui-minimax-h3-audio-T8

COPY model-workers/h3/src/asset_bootstrap.py /opt/astra/h3/asset_bootstrap.py
COPY model-workers/h3/src/server.py /opt/astra/h3/server.py
COPY model-workers/h3/src/build_smoke.py /opt/astra/h3/build_smoke.py
COPY model-workers/h3/src/bundle-entrypoint.sh /opt/astra/h3/bundle-entrypoint.sh
COPY model-workers/h3/workflow_ref2va_api.json /opt/astra/h3/workflow_ref2va_api.json
COPY model-workers/h3/weight-manifest.json /etc/astra/h3/weight-manifest.json
COPY model-workers/h3/extra_model_paths.yaml /opt/comfyui/extra_model_paths.yaml

RUN /opt/venv/bin/pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cu128 \
      torch==${ASTRA_TORCH_VERSION}+cu128 \
      torchvision==${ASTRA_TORCHVISION_VERSION}+cu128 \
      torchaudio==${ASTRA_TORCHAUDIO_VERSION}+cu128 \
    && grep -Ev '^(torch|torchvision|torchaudio)([<=>]|$)' /opt/comfyui/requirements.txt > /tmp/comfyui-requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/comfyui-requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir -r /opt/comfyui/custom_nodes/ComfyUI-KJNodes/requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir -r /opt/comfyui/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir -r /opt/comfyui/custom_nodes/ComfyUI-H3-FaceRefine/requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir -r /opt/comfyui/custom_nodes/comfyui-minimax-h3-audio-T8/requirements.txt sageattention==1.0.6 \
    && chmod 0755 /opt/astra/h3/bundle-entrypoint.sh \
    && /opt/venv/bin/python /opt/astra/h3/build_smoke.py \
    && find /var/lib/astra/h3/weights -type f -delete \
    && chown -R astra:astra /opt/astra /opt/comfyui /opt/venv /var/lib/astra /work \
    && chmod 0700 /var/lib/astra/h3/weights /work /work/executions /work/tasks /opt/comfyui/input /opt/comfyui/output

USER astra
WORKDIR /opt/astra
ENTRYPOINT ["/opt/astra/h3/bundle-entrypoint.sh"]
