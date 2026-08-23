import json
import tempfile
import unittest
from pathlib import Path

from asset_bootstrap import BootstrapError, load_manifest, materialize


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


if __name__ == "__main__":
    unittest.main()
