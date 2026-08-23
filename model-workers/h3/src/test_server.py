import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path

from server import ComfyClient, H3ModelApp, normalize_prompt


class ContractComfy(ComfyClient):
    def __init__(self) -> None:
        super().__init__("http://127.0.0.1:1")
        self.submitted: list[str] = []

    def ready(self) -> bool:
        return True

    def submit(self, workflow: dict, prompt_id: str) -> str:
        self.submitted.append(prompt_id)
        return prompt_id

    def history(self, prompt_id: str):
        return None

    def interrupt(self, prompt_id: str) -> None:
        return


class H3ModelAppContractTest(unittest.TestCase):
    def test_work_fisher_media_tags_are_normalized_without_touching_other_text(self) -> None:
        self.assertEqual(normalize_prompt("@图片1参考@视频2和@音频1"), "<Picture 1>参考<Video 2>和<Audio 1>")

    def test_capabilities_and_live_health_do_not_require_weights(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = H3ModelApp(
                release="release_h3",
                execution_root=root / "executions",
                comfy=ContractComfy(),
                template_path=Path(__file__).parents[1] / "workflow_ref2va_api.json",
                comfy_input_root=root / "comfy-input",
                comfy_output_root=root / "comfy-output",
                work_root=root / "tasks",
            )
            status, body = app.handle("GET", "/health/live")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["status"], "ok")
            status, body = app.handle("GET", "/v1/capabilities")
            self.assertEqual(status, 200)
            capabilities = json.loads(body)
            self.assertEqual(capabilities["capabilities"]["resolutions"], ["0.7mp", "0.9mp", "2.0mp"])

    def test_input_integrity_and_execution_idempotency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attempt = root / "tasks" / "attempt_1"
            (attempt / "inputs").mkdir(parents=True)
            (attempt / "outputs").mkdir()
            source = attempt / "inputs" / "ref.png"
            data = b"reference-image"
            source.write_bytes(data)
            request = {
                "execution_id": "attempt_1",
                "task_id": "task_1",
                "type": "video",
                "operation": "generation",
                "model_release": "release_h3",
                "request": {
                    "prompt": "a test scene",
                    "aspect_ratio": "16:9",
                    "resolution": "0.7mp",
                    "width": 1152,
                    "height": 640,
                    "duration": 15,
                    "audio": {"mode": "native"},
                    "seed": 1234,
                },
                "inputs": [
                    {
                        "file_id": "file_1",
                        "type": "image",
                        "role": "reference_image",
                        "path": str(source),
                        "content_type": "image/png",
                        "size_bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                    }
                ],
                "output_dir": str(attempt / "outputs"),
                "deadline_at": int(time.time()) + 120,
            }
            app = H3ModelApp(
                release="release_h3",
                execution_root=root / "executions",
                comfy=ContractComfy(),
                template_path=Path(__file__).parents[1] / "workflow_ref2va_api.json",
                comfy_input_root=root / "comfy-input",
                comfy_output_root=root / "comfy-output",
                work_root=root / "tasks",
                poll_seconds=0.01,
            )
            status, _ = app.handle("POST", "/v1/inferences", request)
            self.assertEqual(status, 202)
            status, body = app.handle("POST", "/v1/inferences", request)
            self.assertEqual(status, 202)
            self.assertEqual(json.loads(body)["execution_id"], "attempt_1")
            conflict = dict(request)
            conflict["task_id"] = "task_other"
            status, body = app.handle("POST", "/v1/inferences", conflict)
            self.assertEqual(status, 409)
            app.handle("POST", "/v1/inferences/attempt_1/cancel")
            for _ in range(100):
                status, body = app.handle("GET", "/v1/inferences/attempt_1")
                if json.loads(body)["status"] in {"canceled", "failed"}:
                    break
                time.sleep(0.01)


if __name__ == "__main__":
    unittest.main()
