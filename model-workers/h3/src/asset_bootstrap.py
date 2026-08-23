#!/usr/bin/env python3
"""Validate and optionally materialize a fixed H3 weight manifest before exec."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    import fcntl
except ImportError:  # pragma: no cover - production image is Linux; keep import errors explicit below.
    fcntl = None


CHUNK_SIZE = 8 * 1024 * 1024
MAX_REDIRECTS = 3


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request: Request, response: Any, code: int, msg: str, headers: Any, new_url: str) -> None:
        return None


class BootstrapError(RuntimeError):
    pass


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise BootstrapError(f"missing_required_environment:{name}")
    return value


def parse_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    if raw.lower() not in {"true", "false"}:
        raise BootstrapError(f"invalid_boolean_environment:{name}")
    return raw.lower() == "true"


def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise BootstrapError(f"invalid_integer_environment:{name}") from error
    if value < minimum or value > maximum:
        raise BootstrapError(f"out_of_range_environment:{name}")
    return value


@contextmanager
def materialize_lock(root: Path):
    if fcntl is None:
        raise BootstrapError("file_lock_unavailable")
    lock_path = root / ".weight-manifest.lock"
    with lock_path.open("a+", encoding="ascii") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def load_manifest(path: Path) -> list[dict[str, Any]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BootstrapError(f"invalid_weight_manifest:{path}") from error
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise BootstrapError("unsupported_weight_manifest_schema")
    artifacts = document.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise BootstrapError("weight_manifest_has_no_artifacts")
    seen_targets: set[str] = set()
    validated: list[dict[str, Any]] = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise BootstrapError("weight_manifest_artifact_is_not_object")
        name = artifact.get("name")
        url = artifact.get("url")
        sha256 = artifact.get("sha256")
        size_bytes = artifact.get("size_bytes")
        target = artifact.get("target")
        if (
            not isinstance(name, str)
            or not name
            or not isinstance(url, str)
            or not isinstance(sha256, str)
            or len(sha256) != 64
            or any(character not in "0123456789abcdef" for character in sha256)
            or not isinstance(size_bytes, int)
            or size_bytes <= 0
            or not isinstance(target, str)
            or not target
        ):
            raise BootstrapError(f"invalid_weight_manifest_artifact:{name}")
        parsed_url = urlparse(url)
        if parsed_url.scheme != "https" or not parsed_url.hostname:
            raise BootstrapError(f"weight_url_must_be_https:{name}")
        target_path = Path(target)
        if target_path.is_absolute() or ".." in target_path.parts:
            raise BootstrapError(f"weight_target_escapes_root:{name}")
        target_key = target_path.as_posix()
        if target_key in seen_targets:
            raise BootstrapError(f"duplicate_weight_target:{target_key}")
        seen_targets.add(target_key)
        validated.append({"name": name, "url": url, "sha256": sha256, "size_bytes": size_bytes, "target": target_key})
    return validated


def allowed_hosts() -> set[str]:
    raw = os.environ.get("H3_WEIGHT_ALLOWED_HOSTS", "").strip()
    if not raw:
        raise BootstrapError("missing_required_environment:H3_WEIGHT_ALLOWED_HOSTS")
    hosts = {host.strip().lower() for host in raw.split(",") if host.strip()}
    if not hosts:
        raise BootstrapError("empty_weight_host_allowlist")
    return hosts


def validate_url(url: str, hosts: set[str]) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname is None or parsed.hostname.lower() not in hosts:
        raise BootstrapError("weight_url_host_not_allowed")


def digest_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def verified(path: Path, artifact: dict[str, Any]) -> bool:
    if not path.is_file():
        return False
    digest, size = digest_file(path)
    return size == artifact["size_bytes"] and digest == artifact["sha256"]


def download(url: str, destination: Path, expected_size: int, hosts: set[str]) -> None:
    current_url = url
    opener = build_opener(NoRedirectHandler())
    for _ in range(MAX_REDIRECTS + 1):
        validate_url(current_url, hosts)
        request = Request(current_url, headers={"User-Agent": "astra-h3-runtime/1"})
        try:
            response = opener.open(request, timeout=120)
        except HTTPError as error:
            if error.code in {301, 302, 303, 307, 308}:
                redirected = error.headers.get("Location")
                error.close()
                if not redirected:
                    raise BootstrapError(f"weight_redirect_without_location:{url}") from error
                current_url = redirected
                continue
            raise BootstrapError(f"weight_download_failed:{url}") from error
        except (URLError, TimeoutError) as error:
            raise BootstrapError(f"weight_download_failed:{url}") from error
        if response.status in {301, 302, 303, 307, 308}:
            redirected = response.headers.get("Location")
            response.close()
            if not redirected:
                raise BootstrapError(f"weight_redirect_without_location:{url}")
            current_url = redirected
            continue
        if response.status != 200:
            response.close()
            raise BootstrapError(f"weight_download_status:{response.status}")
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError as error:
                response.close()
                raise BootstrapError(f"invalid_weight_content_length:{url}") from error
            if declared_size != expected_size:
                response.close()
                raise BootstrapError(f"weight_content_length_mismatch:{url}")
        written = 0
        try:
            with destination.open("wb") as stream:
                while chunk := response.read(CHUNK_SIZE):
                    written += len(chunk)
                    if written > expected_size:
                        raise BootstrapError(f"weight_download_exceeds_manifest_size:{url}")
                    stream.write(chunk)
        finally:
            response.close()
        if written != expected_size:
            raise BootstrapError(f"weight_download_size_mismatch:{url}")
        return
    raise BootstrapError(f"weight_redirect_limit_exceeded:{url}")


def materialize(root: Path, artifacts: list[dict[str, Any]], enabled: bool, hosts: set[str], maximum_retries: int) -> None:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with materialize_lock(root):
        for artifact in artifacts:
            target = root / artifact["target"]
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if verified(target, artifact):
                continue
            if target.exists():
                target.unlink()
            if not enabled:
                raise BootstrapError(f"weight_missing_or_hash_mismatch:{artifact['name']}")
            partial = Path(f"{target}.partial.{os.getpid()}")
            try:
                last_error: BootstrapError | None = None
                for attempt in range(maximum_retries + 1):
                    try:
                        download(artifact["url"], partial, artifact["size_bytes"], hosts)
                        digest, size = digest_file(partial)
                        if digest != artifact["sha256"] or size != artifact["size_bytes"]:
                            raise BootstrapError(f"weight_hash_mismatch:{artifact['name']}")
                        last_error = None
                        break
                    except BootstrapError as error:
                        last_error = error
                        partial.unlink(missing_ok=True)
                        if attempt < maximum_retries:
                            time.sleep(min(30, 2**attempt))
                if last_error is not None:
                    raise last_error
                os.chmod(partial, 0o600)
                os.replace(partial, target)
            finally:
                partial.unlink(missing_ok=True)


def exec_model_app() -> None:
    raw_command = required_env("H3_MODEL_APP_COMMAND_JSON")
    try:
        command = json.loads(raw_command)
    except json.JSONDecodeError as error:
        raise BootstrapError("invalid_model_app_command_json") from error
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise BootstrapError("model_app_command_must_be_non_empty_string_array")
    os.execvp(command[0], command)


def main() -> int:
    try:
        manifest_path = Path(required_env("H3_WEIGHT_MANIFEST"))
        root = Path(required_env("H3_WEIGHT_ROOT"))
        enabled = parse_bool("H3_RUNTIME_WEIGHT_DOWNLOAD_ENABLED")
        hosts = allowed_hosts() if enabled else set()
        maximum_retries = bounded_int("H3_WEIGHT_DOWNLOAD_MAX_RETRIES", 2, 0, 5)
        artifacts = load_manifest(manifest_path)
        materialize(root, artifacts, enabled, hosts, maximum_retries)
        exec_model_app()
    except BootstrapError as error:
        print(json.dumps({"component": "h3-runtime-bootstrap", "status": "failed", "error": str(error)}), file=sys.stderr)
        return 78
    except OSError as error:
        print(json.dumps({"component": "h3-runtime-bootstrap", "status": "failed", "error": "model_app_exec_failed"}), file=sys.stderr)
        return 126
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
