#!/usr/bin/env python3
"""Build-time validation for the weightless H3 bundle image."""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path


WORKFLOW_NODES = {
    "MiniMaxH3AudioConditioningT8": "h3/nodes.py",
    "MiniMaxH3AVDecodeT8": "h3/nodes.py",
    "MiniMaxH3MultiRateSamplerEXPT8": "h3/nodes_multirate_exp.py",
    "MiniMaxH3MemoryEfficientSageAttentionPatch": "kj/__init__.py",
    "VHS_VideoCombine": "vhs/videohelpersuite/nodes.py",
}


def classes_in(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return {node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)}


def main() -> int:
    comfy_root = Path(os.environ.get("H3_BUILD_COMFYUI_ROOT", "/opt/comfyui"))
    workflow_path = Path(os.environ.get("H3_WORKFLOW_TEMPLATE", "/opt/astra/h3/workflow_ref2va_api.json"))
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
    observed = {
        str(node.get("class_type"))
        for node in workflow.values()
        if isinstance(node, dict) and isinstance(node.get("class_type"), str)
    }
    missing_workflow_nodes = sorted(set(WORKFLOW_NODES) - observed)
    if missing_workflow_nodes:
        raise SystemExit(f"workflow_missing_nodes:{','.join(missing_workflow_nodes)}")

    source_map = {
        "h3/nodes.py": comfy_root / "custom_nodes" / "comfyui-minimax-h3-audio-T8" / "nodes.py",
        "h3/nodes_multirate_exp.py": comfy_root / "custom_nodes" / "comfyui-minimax-h3-audio-T8" / "nodes_multirate_exp.py",
        "kj/__init__.py": comfy_root / "custom_nodes" / "ComfyUI-KJNodes" / "__init__.py",
        "vhs/videohelpersuite/nodes.py": comfy_root / "custom_nodes" / "ComfyUI-VideoHelperSuite" / "videohelpersuite" / "nodes.py",
    }
    for node_name, source_key in WORKFLOW_NODES.items():
        source = source_map[source_key]
        if not source.is_file():
            raise SystemExit(f"node_source_missing:{node_name}:{source}")
        if node_name not in classes_in(source) and node_name not in source.read_text(encoding="utf-8"):
            raise SystemExit(f"node_class_missing:{node_name}:{source}")

    for path in (comfy_root / "main.py", comfy_root / "comfyui_version.py", Path("/opt/astra/h3/server.py")):
        if not path.is_file():
            raise SystemExit(f"runtime_file_missing:{path}")

    forbidden_suffixes = {".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".onnx"}
    weight_root = Path(os.environ.get("H3_WEIGHT_ROOT", "/var/lib/astra/h3/weights"))
    present = [path for path in weight_root.rglob("*") if path.is_file() and path.suffix in forbidden_suffixes]
    if present:
        raise SystemExit(f"weight_found_in_build:{present[0]}")
    if os.environ.get("H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED", "false").lower() != "false":
        raise SystemExit("weight_download_must_be_disabled_during_build")

    for target in (comfy_root, Path("/opt/astra/h3")):
        for source in target.rglob("*.py"):
            ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    print(json.dumps({"component": "h3-bundle-build-smoke", "status": "ok", "workflow_nodes": sorted(WORKFLOW_NODES)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
