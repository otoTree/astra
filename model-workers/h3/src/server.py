"""Astra H3 Model App backed by a local ComfyUI API.

The process intentionally has no model installation logic. The image must contain
ComfyUI and every custom node; ``asset_bootstrap.py`` only materializes the
declared weight manifest before this process starts.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class ModelAppError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.status = status


class ComfyError(ModelAppError):
    pass


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def file_digest(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def normalize_prompt(prompt: str) -> str:
    """Translate Work-Fisher's Chinese @媒体N notation to H3 official tags."""
    replacements = {"图片": "Picture", "视频": "Video", "音频": "Audio"}
    for source, target in replacements.items():
        prompt = re.sub(rf"@{source}\s*(\d+)", rf"<{target} \1>", prompt)
    return prompt


def json_response(body: Any, status: int = 200) -> tuple[int, bytes]:
    return status, json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def log_event(event: str, **fields: Any) -> None:
    record: dict[str, Any] = {"component": "h3-model-app", "event": event, "timestamp": time.time()}
    record.update(fields)
    print(json.dumps(record, ensure_ascii=False, separators=(",", ":")), flush=True)


def error_response(error: ModelAppError) -> tuple[int, bytes]:
    return json_response(
        {
            "error": {
                "type": "server_error" if error.status >= 500 else "invalid_request_error",
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "request_id": f"req_{uuid.uuid4().hex}",
            }
        },
        error.status,
    )


def start_comfyui() -> subprocess.Popen[bytes] | None:
    raw = os.environ.get("H3_COMFYUI_COMMAND_JSON", "[]")
    try:
        command = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit("H3_COMFYUI_COMMAND_JSON must be a JSON array") from error
    if command == []:
        return None
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise SystemExit("H3_COMFYUI_COMMAND_JSON must be a non-empty string array")
    return subprocess.Popen(command, start_new_session=True)


def safe_execution_id(value: str) -> str:
    if not value or len(value) > 128 or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in value):
        raise ModelAppError("invalid_execution_id", "execution_id contains unsupported characters", status=422)
    return value


def path_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def resolution_dimensions(aspect_ratio: str, resolution: str) -> tuple[int, int]:
    matrix = {
        ("16:9", "0.7mp"): (1152, 640),
        ("16:9", "0.9mp"): (1280, 736),
        ("16:9", "2.0mp"): (1920, 1088),
        ("9:16", "0.7mp"): (640, 1152),
        ("9:16", "0.9mp"): (736, 1280),
        ("9:16", "2.0mp"): (1088, 1920),
        ("1:1", "0.7mp"): (832, 832),
        ("1:1", "0.9mp"): (960, 960),
        ("1:1", "2.0mp"): (1408, 1408),
    }
    try:
        return matrix[(aspect_ratio, resolution)]
    except KeyError as error:
        raise ModelAppError("unsupported_resolution", "aspect_ratio and resolution are not in this Release", status=422) from error


def frame_length(duration: float, fps: int = 24) -> int:
    if not 4 <= duration <= 15:
        raise ModelAppError("unsupported_duration", "duration must be between 4 and 15 seconds", status=422)
    raw = max(5, round(duration * fps))
    return raw + (5 - (raw % 17)) % 17


@dataclass
class Execution:
    execution_id: str
    request_hash: str
    request: dict[str, Any]
    status: str = "accepted"
    stage: str | None = None
    progress: float | None = 0
    message: str | None = None
    error: dict[str, Any] | None = None
    metrics: dict[str, float] | None = None
    prompt_id: str | None = None
    cancel_requested: bool = False
    created_at: float = 0
    updated_at: float = 0
    manifest: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {key: value for key, value in self.__dict__.items() if value is not None}

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Execution":
        return cls(**value)


class ExecutionStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def _path(self, execution_id: str) -> Path:
        return self.root / f"{safe_execution_id(execution_id)}.json"

    def get(self, execution_id: str) -> Execution | None:
        with self.lock:
            path = self._path(execution_id)
            if not path.exists():
                return None
            return Execution.from_dict(json.loads(path.read_text(encoding="utf-8")))

    def put(self, execution: Execution) -> None:
        with self.lock:
            execution.updated_at = time.time()
            target = self._path(execution.execution_id)
            temporary = target.with_suffix(f".json.partial.{os.getpid()}.{secrets.token_hex(4)}")
            temporary.write_text(json.dumps(execution.to_dict(), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)

    def active(self) -> list[Execution]:
        with self.lock:
            values: list[Execution] = []
            for path in self.root.glob("*.json"):
                try:
                    item = Execution.from_dict(json.loads(path.read_text(encoding="utf-8")))
                except (OSError, ValueError, TypeError):
                    continue
                if item.status in {"accepted", "running", "post_processing", "canceling"}:
                    values.append(item)
            return values

    def recover_after_restart(self) -> None:
        for item in self.active():
            item.status = "failed"
            item.stage = "recovery"
            item.progress = None
            item.error = {
                "code": "model_app_restarted",
                "message": "Execution was interrupted when the Model App restarted",
                "retryable": True,
            }
            self.put(item)


class ComfyClient:
    def __init__(self, base_url: str, timeout_seconds: float = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"content-type": "application/json", "accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise ComfyError("comfy_unavailable", "ComfyUI API is unavailable", True, 503) from error
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ComfyError("comfy_invalid_response", "ComfyUI returned invalid JSON", True, 502) from error

    def submit(self, workflow: dict[str, Any], prompt_id: str) -> str:
        response = self.request("POST", "/prompt", {"prompt": workflow, "prompt_id": prompt_id})
        if not isinstance(response, dict) or not isinstance(response.get("prompt_id"), str):
            raise ComfyError("comfy_prompt_rejected", "ComfyUI did not return a prompt_id", False, 502)
        return response["prompt_id"]

    def history(self, prompt_id: str) -> dict[str, Any] | None:
        response = self.request("GET", f"/history/{prompt_id}")
        if not isinstance(response, dict):
            return None
        value = response.get(prompt_id)
        return value if isinstance(value, dict) else None

    def interrupt(self, prompt_id: str) -> None:
        try:
            self.request("POST", "/interrupt", {"prompt_id": prompt_id})
        except ComfyError:
            # Cancellation is reconciled through history; an unavailable interrupt
            # endpoint must not turn a user cancellation into an execution retry.
            return

    def ready(self) -> bool:
        try:
            self.request("GET", "/system_stats")
            return True
        except ComfyError:
            return False


class WorkflowBuilder:
    def __init__(self, template_path: Path, comfy_input_root: Path, work_root: Path) -> None:
        self.template_path = template_path
        self.comfy_input_root = comfy_input_root
        self.work_root = work_root

    def _copy_input(self, source: Path, execution_id: str, index: int) -> str:
        if not source.is_file():
            raise ModelAppError("input_not_found", f"Input file does not exist: {source.name}", False, 422)
        name = f"astra/{execution_id}/{index:02d}_{source.name}"
        target = self.comfy_input_root / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if target.exists():
            if file_digest(target) != file_digest(source):
                raise ModelAppError("input_materialization_conflict", "ComfyUI input path is already occupied", False, 409)
        else:
            shutil.copyfile(source, target)
            os.chmod(target, 0o600)
        return name

    @staticmethod
    def _verify_input(source: Path, item: dict[str, Any]) -> None:
        expected_size = item.get("size_bytes")
        expected_hash = item.get("sha256")
        if not isinstance(expected_size, int) or expected_size < 0:
            raise ModelAppError("invalid_input_size", "input size_bytes must be a non-negative integer", False, 422)
        if not isinstance(expected_hash, str) or len(expected_hash) != 64 or any(character not in "0123456789abcdef" for character in expected_hash):
            raise ModelAppError("invalid_input_hash", "input sha256 must be lowercase hexadecimal", False, 422)
        actual_hash, actual_size = file_digest(source)
        if actual_size != expected_size or actual_hash != expected_hash:
            raise ModelAppError("input_integrity_mismatch", "input size or SHA-256 does not match the Worker manifest", False, 422)

    @staticmethod
    def _loader(workflow: dict[str, Any], node_id: str, class_type: str, inputs: dict[str, Any], title: str) -> None:
        workflow[node_id] = {"class_type": class_type, "inputs": inputs, "_meta": {"title": title}}

    def build(self, execution: Execution) -> dict[str, Any]:
        request = execution.request
        body = request.get("request")
        if not isinstance(body, dict):
            raise ModelAppError("invalid_request", "request must be an object", False, 422)
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ModelAppError("invalid_prompt", "prompt must be a non-empty string", False, 422)
        prompt = normalize_prompt(prompt)
        aspect_ratio = body.get("aspect_ratio", "16:9")
        resolution = body.get("resolution", "0.7mp")
        if not isinstance(aspect_ratio, str) or not isinstance(resolution, str):
            raise ModelAppError("invalid_resolution", "aspect_ratio and resolution must be strings", False, 422)
        width, height = resolution_dimensions(aspect_ratio, resolution)
        if body.get("width", width) != width or body.get("height", height) != height:
            raise ModelAppError("resolution_mismatch", "width and height do not match the Release matrix", False, 422)
        duration = body.get("duration", 15)
        if not isinstance(duration, (int, float)) or isinstance(duration, bool):
            raise ModelAppError("invalid_duration", "duration must be a number", False, 422)
        length = frame_length(float(duration))
        audio = body.get("audio", {"mode": "native"})
        audio_mode = audio.get("mode", "native") if isinstance(audio, dict) else "native"
        mode_mapping = {"native": "native", "reference": "reference_only", "lock_source": "lock_source", "remix_source": "remix_source"}
        if audio_mode not in mode_mapping:
            raise ModelAppError("unsupported_audio_mode", "audio mode is not supported by this Release", False, 422)
        try:
            workflow = json.loads(self.template_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ModelAppError("workflow_invalid", "fixed API workflow is unavailable or invalid", False, 500) from error
        conditioning = workflow["7"]["inputs"]
        conditioning.update({"prompt": prompt, "width": width, "height": height, "length": length, "audio_mode": mode_mapping[audio_mode]})
        seed = body.get("seed")
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**63:
            raise ModelAppError("invalid_seed", "Worker request must contain the system-generated seed", False, 422)
        workflow["9"]["inputs"]["noise_seed"] = seed

        inputs = request.get("inputs")
        if not isinstance(inputs, list) or len(inputs) > 16:
            raise ModelAppError("invalid_inputs", "inputs must be an array with at most 16 entries", False, 422)
        output_value = request.get("output_dir")
        if not isinstance(output_value, str):
            raise ModelAppError("invalid_output_dir", "output_dir must be a local path", False, 422)
        task_root = Path(output_value).parent
        if not path_within(Path(output_value), self.work_root) or Path(output_value).name != "outputs":
            raise ModelAppError("invalid_output_dir", "output_dir must be an Attempt outputs directory", False, 422)
        image_index = video_index = reference_audio_index = video_audio_index = 0
        source_audio_seen = False
        reference_audio_links: list[list[Any]] = []
        node_id = 100
        for index, item in enumerate(inputs):
            if not isinstance(item, dict):
                raise ModelAppError("invalid_input", "each input must be an object", False, 422)
            file_type = item.get("type")
            role = item.get("role")
            source_value = item.get("path")
            if file_type not in {"image", "video", "audio"} or not isinstance(role, str) or not isinstance(source_value, str):
                raise ModelAppError("invalid_input", "input type, role and path are required", False, 422)
            content_type = item.get("content_type")
            allowed_content_types = {
                "image": {"image/png", "image/jpeg", "image/webp"},
                "video": {"video/mp4", "video/quicktime"},
                "audio": {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/flac", "audio/x-flac"},
            }
            if not isinstance(content_type, str) or content_type not in allowed_content_types[file_type]:
                raise ModelAppError("unsupported_input_content_type", "input content_type is not allowed for its type", False, 422)
            source = Path(source_value)
            if not path_within(source, task_root / "inputs") or not path_within(source, self.work_root):
                raise ModelAppError("invalid_input_path", "input path must belong to its attempt directory", False, 422)
            if not source.is_file():
                raise ModelAppError("input_not_found", "input file does not exist", False, 422)
            self._verify_input(source, item)
            copied = self._copy_input(source, execution.execution_id, index)
            if file_type == "image":
                self._loader(workflow, str(node_id), "LoadImage", {"image": copied}, f"Reference image {image_index + 1}")
                output = [str(node_id), 0]
                if role == "first_frame":
                    conditioning["first_frame"] = output
                elif role == "last_frame":
                    conditioning["last_frame"] = output
                elif role == "reference_image":
                    if image_index >= 4:
                        raise ModelAppError("too_many_reference_images", "this Release accepts at most four reference images", False, 422)
                    conditioning[f"ref_images.ref_image_{image_index}"] = output
                    image_index += 1
                else:
                    raise ModelAppError("unsupported_input_role", f"image role is not supported: {role}", False, 422)
                node_id += 1
                continue
            if file_type == "video":
                if role not in {"reference_video", "source_video"} or video_index >= 3:
                    raise ModelAppError("unsupported_input_role", "video role or count is not supported by this Release", False, 422)
                self._loader(workflow, str(node_id), "LoadVideo", {"file": copied}, f"Reference video {video_index + 1}")
                self._loader(workflow, str(node_id + 1), "GetVideoComponents", {"video": [str(node_id), 0]}, f"Reference video components {video_index + 1}")
                conditioning[f"ref_videos.ref_video_{video_index}"] = [str(node_id + 1), 0]
                conditioning[f"ref_video_audios.ref_video_audio_{video_index}"] = [str(node_id + 1), 1]
                if role == "source_video":
                    conditioning["add_source_as_reference"] = True
                video_index += 1
                node_id += 2
                continue
            if role not in {"reference_audio", "reference_video_audio", "source_audio"}:
                raise ModelAppError("unsupported_input_role", "audio role is not supported by this Release", False, 422)
            self._loader(workflow, str(node_id), "LoadAudio", {"audio": copied}, "Astra audio input")
            if role == "source_audio":
                if source_audio_seen:
                    raise ModelAppError("too_many_source_audio", "this Release accepts one source_audio", False, 422)
                conditioning["drive_audio"] = [str(node_id), 0]
                conditioning["final_audio"] = [str(node_id), 0]
                source_audio_seen = True
            elif role == "reference_video_audio":
                if video_audio_index >= 3:
                    raise ModelAppError("too_many_reference_video_audio", "this Release accepts at most three reference video audio tracks", False, 422)
                link = [str(node_id), 0]
                conditioning[f"ref_video_audios.ref_video_audio_{video_audio_index}"] = link
                reference_audio_links.append(link)
                video_audio_index += 1
            else:
                if reference_audio_index >= 3:
                    raise ModelAppError("too_many_reference_audio", "this Release accepts at most three reference audio tracks", False, 422)
                link = [str(node_id), 0]
                conditioning[f"ref_audios.ref_audio_{reference_audio_index}"] = link
                reference_audio_links.append(link)
                reference_audio_index += 1
            node_id += 1
        if audio_mode != "native" and "drive_audio" not in conditioning:
            if not reference_audio_links:
                raise ModelAppError("audio_input_required", "this audio mode requires a reference or source audio", False, 422)
            conditioning["drive_audio"] = reference_audio_links[0]
        return workflow


def output_metadata(path: Path, ffprobe: str, ffmpeg: str) -> dict[str, Any]:
    content_type = mimetypes.guess_type(path.name)[0]
    if content_type != "video/mp4":
        raise ModelAppError("output_type_invalid", "H3 Release must produce an MP4 video", False, 502)
    try:
        process = subprocess.run(
            [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ModelAppError("output_validation_unavailable", "ffprobe is required to validate H3 output", True, 502) from error
    if process.returncode != 0:
        raise ModelAppError("output_decode_failed", "FFmpeg could not completely decode the H3 output", False, 502)
    try:
        report = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise ModelAppError("output_validation_invalid", "ffprobe returned invalid metadata", False, 502) from error
    streams = report.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not isinstance(video, dict):
        raise ModelAppError("output_video_missing", "H3 output has no video stream", False, 502)
    metadata: dict[str, Any] = {
        "media_type": "video",
        "container": "mp4",
        "width": int(video["width"]),
        "height": int(video["height"]),
        "duration_seconds": float(video.get("duration") or report.get("format", {}).get("duration") or 0),
        "video_codec": str(video.get("codec_name", "unknown")),
    }
    rate = video.get("avg_frame_rate")
    if isinstance(rate, str) and "/" in rate:
        numerator, denominator = rate.split("/", 1)
        if float(denominator) > 0:
            metadata["fps"] = float(numerator) / float(denominator)
    if audio is not None:
        metadata.update(
            {
                "audio_codec": str(audio.get("codec_name", "unknown")),
                "audio_sample_rate": int(audio.get("sample_rate", 0)),
                "audio_channels": int(audio.get("channels", 0)),
            }
        )
    if metadata["duration_seconds"] <= 0:
        raise ModelAppError("output_duration_invalid", "H3 output duration is not positive", False, 502)
    try:
        decode = subprocess.run(
            [ffmpeg, "-v", "error", "-xerror", "-i", str(path), "-map", "0", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ModelAppError("output_validation_unavailable", "ffmpeg is required to fully decode H3 output", True, 502) from error
    if decode.returncode != 0:
        raise ModelAppError("output_decode_failed", "FFmpeg could not completely decode the H3 output", False, 502)
    return metadata


class H3ModelApp:
    def __init__(
        self,
        *,
        release: str,
        execution_root: Path,
        comfy: ComfyClient,
        template_path: Path,
        comfy_input_root: Path,
        comfy_output_root: Path,
        work_root: Path = Path("/work/tasks"),
        ffprobe: str = "ffprobe",
        ffmpeg: str = "ffmpeg",
        poll_seconds: float = 2.0,
        deadline_grace_seconds: float = 5.0,
    ) -> None:
        self.release = release
        self.store = ExecutionStore(execution_root)
        self.store.recover_after_restart()
        self.comfy = comfy
        self.workflow_builder = WorkflowBuilder(template_path, comfy_input_root, work_root)
        self.comfy_output_root = comfy_output_root.resolve()
        self.ffprobe = ffprobe
        self.ffmpeg = ffmpeg
        self.poll_seconds = poll_seconds
        self.deadline_grace_seconds = deadline_grace_seconds
        self.lock = threading.RLock()

    def capabilities(self) -> dict[str, Any]:
        matrix: dict[str, dict[str, int]] = {}
        for ratio in ("16:9", "9:16", "1:1"):
            for tier in ("0.7mp", "0.9mp", "2.0mp"):
                width, height = resolution_dimensions(ratio, tier)
                matrix[f"{ratio}/{tier}"] = {"width": width, "height": height}
        return {
            "contract_version": "1.0",
            "app": {
                "name": "minimax-h3-work-fisher-comfyui",
                "version": os.environ.get("H3_APP_VERSION", "0.1.0"),
                "build": os.environ.get("H3_APP_BUILD", "unreleased"),
            },
            "model_release": self.release,
            "modalities": ["video"],
            "operations": ["generation"],
            "max_concurrency": 1,
            "capabilities": {
                "aspect_ratios": ["16:9", "9:16", "1:1"],
                "resolutions": ["0.7mp", "0.9mp", "2.0mp"],
                "resolution_matrix": matrix,
                "durations": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
                "fps": [24],
                "input_types": ["image", "video", "audio"],
                "input_roles": ["reference_image", "first_frame", "last_frame", "reference_video", "reference_audio", "source_video"],
                "audio_modes": ["native", "reference", "lock_source", "remix_source"],
                "supports_cancel": True,
                "supports_progress": True,
                "supports_resume": False,
            },
            "artifacts": {
                "output_artifacts": [{"role": "result", "content_types": ["video/mp4"]}],
                "max_outputs": 1,
                "sidecar_manifest_allowed": True,
                "post_processing": "model_app_only",
            },
        }

    def _active_count(self) -> int:
        return len(self.store.active())

    def _status(self, item: Execution) -> dict[str, Any]:
        if item.manifest is not None:
            return item.manifest
        result: dict[str, Any] = {"execution_id": item.execution_id, "status": item.status}
        for key in ("stage", "progress", "message", "metrics", "error"):
            value = getattr(item, key)
            if value is not None:
                result[key] = value
        return result

    def _set_error(self, item: Execution, error: ModelAppError) -> None:
        item.status = "failed"
        item.progress = None
        item.error = {"code": error.code, "message": str(error), "retryable": error.retryable}
        self.store.put(item)
        log_event("execution_failed", execution_id=item.execution_id, code=error.code, retryable=error.retryable)

    def _smoke(self, payload: Any) -> tuple[int, bytes]:
        started = time.monotonic()
        if not isinstance(payload, dict) or not isinstance(payload.get("validation_id"), str):
            raise ModelAppError("invalid_smoke_request", "validation_id and model_release are required", False, 422)
        validation_id = payload["validation_id"]
        if payload.get("model_release") != self.release:
            raise ModelAppError("unsupported_capability", "model_release does not match this image", False, 422)
        readiness = self.comfy.ready()
        capabilities = self.capabilities()
        enabled = os.environ.get("H3_SMOKE_EXECUTION_ENABLED", "false").lower() == "true"
        checks = {"readiness": readiness, "capabilities": True, "execution": False, "output_contract": False}
        failure_code: str | None = None
        if not readiness:
            failure_code = "comfy_not_ready"
        elif not enabled:
            failure_code = "smoke_execution_not_enabled"
        else:
            smoke_id = f"smoke_{hashlib.sha256(validation_id.encode('utf-8')).hexdigest()[:32]}"
            smoke_request = {
                "execution_id": smoke_id,
                "task_id": f"smoke_task_{validation_id}",
                "type": "video",
                "operation": "generation",
                "model_release": self.release,
                "request": {
                    "prompt": "A neutral studio light with a slow camera push, synchronized natural ambience.",
                    "aspect_ratio": "16:9",
                    "resolution": "0.7mp",
                    "width": 1152,
                    "height": 640,
                    "duration": 4,
                    "audio": {"mode": "native"},
                    "seed": secrets.randbits(63),
                },
                "inputs": [],
                "output_dir": str(self.workflow_builder.work_root / smoke_id / "outputs"),
                "deadline_at": int(time.time()) + 600,
            }
            if self._active_count() >= 1:
                failure_code = "worker_busy"
            else:
                self.handle("POST", "/v1/inferences", smoke_request)
                while True:
                    item = self.store.get(smoke_id)
                    if item is not None and item.status in {"completed", "failed", "canceled"}:
                        checks["execution"] = item.status == "completed"
                        checks["output_contract"] = item.manifest is not None
                        failure_code = None if item.status == "completed" else (item.error or {}).get("code", "smoke_failed")
                        break
                    if time.monotonic() - started > 610:
                        failure_code = "smoke_timeout"
                        break
                    time.sleep(self.poll_seconds)
        result: dict[str, Any] = {
            "validation_id": validation_id,
            "model_release": self.release,
            "status": "passed" if failure_code is None and all(checks.values()) else "failed",
            "evidence_sha256": canonical_hash({"validation_id": validation_id, "capabilities": capabilities, "checks": checks}),
            "duration_ms": int((time.monotonic() - started) * 1000),
            "checks": checks,
        }
        if failure_code is not None:
            result["failure_code"] = failure_code
        return json_response(result)

    def _find_output(self, history: dict[str, Any]) -> Path:
        outputs = history.get("outputs")
        if not isinstance(outputs, dict):
            raise ModelAppError("comfy_output_missing", "ComfyUI history contains no outputs", False, 502)
        candidates: list[Path] = []
        for node_output in outputs.values():
            if not isinstance(node_output, dict):
                continue
            for key in ("videos", "gifs", "images"):
                values = node_output.get(key)
                if not isinstance(values, list):
                    continue
                for value in values:
                    if not isinstance(value, dict) or not isinstance(value.get("filename"), str):
                        continue
                    filename = Path(value["filename"])
                    subfolder = Path(value.get("subfolder", ""))
                    candidate = (self.comfy_output_root / subfolder / filename).resolve()
                    if path_within(candidate, self.comfy_output_root) and candidate.suffix.lower() == ".mp4":
                        candidates.append(candidate)
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        raise ModelAppError("comfy_output_not_ready", "ComfyUI history did not expose a readable MP4", True, 502)

    def _run(self, item: Execution) -> None:
        started = time.monotonic()
        try:
            item.status, item.stage, item.progress = "running", "materializing_inputs", 1
            self.store.put(item)
            workflow = self.workflow_builder.build(item)
            prompt_id = str(uuid.uuid4())
            item.prompt_id = self.comfy.submit(workflow, prompt_id)
            log_event("execution_submitted", execution_id=item.execution_id, prompt_id=item.prompt_id)
            item.stage, item.progress = "sampling", None
            self.store.put(item)
            while True:
                current = self.store.get(item.execution_id)
                if current is not None and current.cancel_requested:
                    item.cancel_requested = True
                    item.status = current.status
                if item.cancel_requested:
                    self.comfy.interrupt(item.prompt_id)
                    item.status, item.stage, item.progress = "canceled", "canceled", None
                    self.store.put(item)
                    return
                if time.time() >= float(item.request["deadline_at"]) + self.deadline_grace_seconds:
                    self.comfy.interrupt(item.prompt_id)
                    raise ModelAppError("deadline_exceeded", "Execution deadline elapsed", True, 408)
                history = self.comfy.history(item.prompt_id)
                if history is not None:
                    status = history.get("status", {})
                    if isinstance(status, dict) and status.get("status_str") in {"error", "failed"}:
                        raise ModelAppError("comfy_execution_failed", "ComfyUI execution failed", False, 502)
                    if "outputs" in history:
                        break
                time.sleep(self.poll_seconds)
            item.status, item.stage, item.progress = "post_processing", "validating_outputs", None
            self.store.put(item)
            source = self._find_output(history)
            output_dir = Path(item.request["output_dir"])
            output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            target = output_dir / "result.mp4"
            shutil.copyfile(source, target)
            os.chmod(target, 0o600)
            data = target.read_bytes()
            metadata = output_metadata(target, self.ffprobe, self.ffmpeg)
            request_body = item.request["request"]
            expected_width, expected_height = resolution_dimensions(
                str(request_body.get("aspect_ratio", "16:9")), str(request_body.get("resolution", "0.7mp"))
            )
            if metadata.get("width") != expected_width or metadata.get("height") != expected_height:
                raise ModelAppError("output_dimensions_mismatch", "H3 output dimensions do not match the Release matrix", False, 502)
            if abs(float(metadata.get("fps", 0)) - 24) > 0.05:
                raise ModelAppError("output_fps_mismatch", "H3 output frame rate does not match the Release contract", False, 502)
            expected_duration = float(request_body.get("duration", 15))
            if abs(float(metadata["duration_seconds"]) - expected_duration) > 1:
                raise ModelAppError("output_duration_mismatch", "H3 output duration does not match the request", False, 502)
            item.status, item.stage, item.progress = "completed", "completed", 100
            item.metrics = {"elapsed_ms": (time.monotonic() - started) * 1000, "output_size_bytes": float(len(data))}
            item.message = "output ready"
            item.manifest = {
                "execution_id": item.execution_id,
                "status": "completed",
                "outputs": [
                    {
                        "role": "result",
                        "path": str(target),
                        "content_type": "video/mp4",
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "size_bytes": len(data),
                        "media": metadata,
                        "provenance": {"producer": "model_app", "transformations": []},
                    }
                ],
                "usage": {
                    "inference_time_ms": (time.monotonic() - started) * 1000,
                    "post_processing_time_ms": 0,
                    "gpu_seconds": 0,
                    "peak_gpu_memory_mb": 0,
                },
            }
            self.store.put(item)
            log_event("execution_completed", execution_id=item.execution_id, output_size_bytes=len(data))
        except ModelAppError as error:
            self._set_error(item, error)
        except (OSError, ValueError, KeyError, TypeError) as error:
            self._set_error(item, ModelAppError("inference_failed", f"H3 execution failed: {error}", False, 502))

    def handle(self, method: str, path: str, payload: Any = None) -> tuple[int, bytes]:
        try:
            if method == "GET" and path == "/health/live":
                return json_response({"status": "ok"})
            if method == "GET" and path == "/health/ready":
                if not self.comfy.ready():
                    return error_response(ModelAppError("comfy_not_ready", "ComfyUI is not ready", True, 503))
                return json_response({"status": "ready", "model_loaded": True, "release": self.release})
            if method == "GET" and path == "/v1/capabilities":
                return json_response(self.capabilities())
            if method == "POST" and path == "/v1/validation/smoke":
                return self._smoke(payload)
            if method == "POST" and path == "/v1/inferences":
                if not isinstance(payload, dict):
                    raise ModelAppError("invalid_request", "request body must be a JSON object", False, 422)
                if payload.get("type") != "video" or payload.get("operation") != "generation":
                    raise ModelAppError("unsupported_capability", "this Model App only accepts video generation", False, 422)
                if not isinstance(payload.get("task_id"), str) or not payload["task_id"]:
                    raise ModelAppError("invalid_request", "task_id is required", False, 422)
                execution_id = safe_execution_id(str(payload.get("execution_id", "")))
                if payload.get("model_release") != self.release:
                    raise ModelAppError("unsupported_capability", "model_release does not match this image", False, 422)
                request_hash = canonical_hash(payload)
                existing = self.store.get(execution_id)
                if existing is not None:
                    if existing.request_hash != request_hash:
                        raise ModelAppError("execution_conflict", "execution_id is already bound to another request", False, 409)
                    return json_response(self._status(existing), 202)
                if not isinstance(payload.get("deadline_at"), (int, float)) or time.time() >= float(payload["deadline_at"]):
                    raise ModelAppError("inference_timeout", "Execution deadline elapsed", True, 408)
                with self.lock:
                    existing = self.store.get(execution_id)
                    if existing is not None:
                        if existing.request_hash != request_hash:
                            raise ModelAppError("execution_conflict", "execution_id is already bound to another request", False, 409)
                        return json_response(self._status(existing), 202)
                    if self._active_count() >= 1:
                        raise ModelAppError("worker_busy", "Model App has no free execution slot", True, 429)
                    item = Execution(execution_id, request_hash, payload, created_at=time.time(), updated_at=time.time())
                    self.store.put(item)
                    threading.Thread(target=self._run, args=(item,), daemon=True, name=f"h3-{execution_id}").start()
                    log_event("execution_accepted", execution_id=execution_id, model_release=self.release)
                return json_response({"execution_id": execution_id, "status": "accepted"}, 202)
            if method == "GET" and path.startswith("/v1/inferences/"):
                execution_id = safe_execution_id(path.rsplit("/", 1)[-1])
                item = self.store.get(execution_id)
                if item is None:
                    raise ModelAppError("execution_not_found", "Execution does not exist", False, 404)
                return json_response(self._status(item))
            if method == "POST" and path.startswith("/v1/inferences/") and path.endswith("/cancel"):
                execution_id = safe_execution_id(path.split("/")[-2])
                item = self.store.get(execution_id)
                if item is None:
                    raise ModelAppError("execution_not_found", "Execution does not exist", False, 404)
                if item.status in {"accepted", "running", "post_processing"}:
                    item.cancel_requested = True
                    item.status = "canceling"
                    self.store.put(item)
                return json_response(self._status(item))
            raise ModelAppError("not_found", "Route not found", False, 404)
        except ModelAppError as error:
            return error_response(error)


class Handler(BaseHTTPRequestHandler):
    app: H3ModelApp

    def do_GET(self) -> None:  # noqa: N802
        status, body = self.app.handle("GET", self.path)
        self._respond(status, body)

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            status, body = error_response(ModelAppError("invalid_json", "Request body is not valid JSON", False, 400))
        else:
            status, body = self.app.handle("POST", self.path, payload)
        self._respond(status, body)

    def _respond(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    release = os.environ.get("MODEL_APP_RELEASE") or os.environ.get("H3_MODEL_RELEASE")
    if not release:
        raise SystemExit("MODEL_APP_RELEASE or H3_MODEL_RELEASE is required")
    execution_root = Path(os.environ.get("H3_EXECUTION_ROOT", "/work/executions"))
    comfy_input_root = Path(os.environ.get("H3_COMFYUI_INPUT_DIR", "/opt/comfyui/input"))
    comfy_output_root = Path(os.environ.get("H3_COMFYUI_OUTPUT_DIR", "/opt/comfyui/output"))
    work_root = Path(os.environ.get("H3_WORK_ROOT", "/work/tasks"))
    default_template = Path(__file__).resolve().parent.parent / "workflow_ref2va_api.json"
    template_path = Path(os.environ.get("H3_WORKFLOW_TEMPLATE", str(default_template)))
    # No external file or package is fetched during startup.
    template_path = template_path.resolve()
    client = ComfyClient(os.environ.get("H3_COMFYUI_URL", "http://127.0.0.1:8188"), float(os.environ.get("H3_COMFYUI_TIMEOUT_SECONDS", "30")))
    comfy_process = start_comfyui()
    app = H3ModelApp(
        release=release,
        execution_root=execution_root,
        comfy=client,
        template_path=template_path,
        comfy_input_root=comfy_input_root,
        comfy_output_root=comfy_output_root,
        work_root=work_root,
        ffprobe=os.environ.get("H3_FFPROBE", "ffprobe"),
        ffmpeg=os.environ.get("H3_FFMPEG", "ffmpeg"),
        poll_seconds=float(os.environ.get("H3_POLL_SECONDS", "2")),
    )
    port = int(os.environ.get("MODEL_APP_PORT", "9000"))
    Handler.app = app
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({"service": "model-app", "implementation": "h3-comfyui", "status": "started", "port": port}))
    try:
        server.serve_forever()
    finally:
        if comfy_process is not None and comfy_process.poll() is None:
            comfy_process.terminate()
            try:
                comfy_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                comfy_process.kill()


if __name__ == "__main__":
    main()
