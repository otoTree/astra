import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from asset_bootstrap import (
    BootstrapError,
    load_manifest,
    materialize,
    mirror_endpoint,
    resolve_download_url,
    validate_url,
)


class AssetBootstrapTest(unittest.TestCase):
    def test_work_fisher_manifest_is_fixed_and_complete(self) -> None:
        manifest_path = Path(__file__).parents[1] / "weight-manifest.json"
        artifacts = load_manifest(manifest_path)
        self.assertEqual(
            {artifact["name"] for artifact in artifacts},
            {
                "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                "minimax_h3_video_vae_fp16.safetensors",
                "minimax_h3_audio_vae_fp32.safetensors",
                "minimax_h3_fl2va_int8_convrot.safetensors",
                "minimax_h3_turbo_4step_comfyui.safetensors",
            },
        )
        source = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertTrue(all("/resolve/" in artifact["url"] for artifact in source["artifacts"]))
        self.assertTrue(all("/resolve/main/" not in artifact["url"] for artifact in source["artifacts"]))

    def test_disabled_download_fails_closed_for_a_missing_weight(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            artifact = {
                "name": "required.safetensors",
                "url": "https://huggingface.co/example/resolve/revision/required.safetensors",
                "sha256": "0" * 64,
                "size_bytes": 1,
                "target": "diffusion_models/required.safetensors",
            }
            with self.assertRaisesRegex(BootstrapError, "weight_missing_or_hash_mismatch"):
                materialize(Path(directory), [artifact], False, set(), 0)

    def test_hugging_face_signed_redirect_hosts_are_explicitly_scoped(self) -> None:
        hosts = {"huggingface.co", "cdn.hf.co", "xethub.hf.co"}
        validate_url("https://us.aws.cdn.hf.co/object", hosts)
        validate_url("https://cas-bridge.xethub.hf.co/object", hosts)
        with self.assertRaisesRegex(BootstrapError, "weight_url_host_not_allowed"):
            validate_url("https://cdn.example.com/object", hosts)

    def test_hugging_face_source_url_is_rewritten_to_configured_mirror(self) -> None:
        source = "https://huggingface.co/org/repo/resolve/fixed-revision/model.safetensors?download=true"
        self.assertEqual(
            resolve_download_url(source, "https://hf-mirror.com"),
            "https://hf-mirror.com/org/repo/resolve/fixed-revision/model.safetensors?download=true",
        )

    def test_non_hugging_face_source_url_is_not_rewritten(self) -> None:
        source = "https://artifacts.example.com/models/model.safetensors"
        self.assertEqual(resolve_download_url(source, "https://hf-mirror.com"), source)

    def test_mirror_endpoint_must_be_an_allowed_https_origin(self) -> None:
        hosts = {"hf-mirror.com"}
        invalid_endpoints = (
            "http://hf-mirror.com",
            "https://user:secret@hf-mirror.com",
            "https://hf-mirror.com/path",
            "https://hf-mirror.com?token=secret",
            "https://unapproved.example.com",
        )
        for endpoint in invalid_endpoints:
            with self.subTest(endpoint=endpoint):
                with patch.dict(os.environ, {"H3_WEIGHT_MIRROR_ENDPOINT": endpoint}, clear=False):
                    with self.assertRaisesRegex(BootstrapError, "invalid_weight_mirror_endpoint"):
                        mirror_endpoint(hosts)

    def test_mirror_endpoint_accepts_allowed_https_origin(self) -> None:
        with patch.dict(os.environ, {"H3_WEIGHT_MIRROR_ENDPOINT": "https://hf-mirror.com/"}, clear=False):
            self.assertEqual(mirror_endpoint({"hf-mirror.com"}), "https://hf-mirror.com")


if __name__ == "__main__":
    unittest.main()
