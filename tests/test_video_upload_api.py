from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

from backend.api.app import create_app


class StubStream:
    def stop(self):
        pass


def make_video(path: Path) -> None:
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 5, (32, 24))
    assert writer.isOpened()
    writer.write(np.zeros((24, 32, 3), dtype=np.uint8))
    writer.release()


def test_upload_rejects_unsupported_extension(tmp_path):
    app = create_app(stream_service=StubStream())
    with TestClient(app) as client:
        response = client.post("/api/videos/upload", files={"file": ("notes.txt", b"not video", "text/plain")})
    assert response.status_code == 415


def test_upload_accepts_multiple_videos_without_restart(tmp_path):
    source = tmp_path / "source.avi"
    make_video(source)
    app = create_app(stream_service=StubStream())
    with TestClient(app) as client:
        ids = []
        for filename in ("first.avi", "second.avi"):
            with source.open("rb") as video:
                response = client.post("/api/videos/upload", files={"file": (filename, video, "video/x-msvideo")})
            assert response.status_code == 201
            assert response.json()["status"] == "ready"
            ids.append(response.json()["video_id"])
    assert ids[0] != ids[1]
