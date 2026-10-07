from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal

import cv2
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = Path("/tmp/etris") if os.getenv("VERCEL") else ROOT
UPLOAD_DIR = RUNTIME_ROOT / "data" / "uploads"
JOB_DIR = RUNTIME_ROOT / "runs" / "video_jobs"
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

router = APIRouter(prefix="/api/videos", tags=["videos"])


class RunVideoRequest(BaseModel):
    pipeline_type: Literal["anpr", "traffic_analytics", "alerts"]


@dataclass
class VideoRecord:
    video_id: str
    filename: str
    path: Path
    created_at: str


@dataclass
class VideoJob:
    job_id: str
    video_id: str
    pipeline_type: str
    status: str
    created_at: str
    error: str | None = None
    result: dict | None = None

    def public(self) -> dict:
        value = asdict(self)
        if self.result:
            value["result"] = {
                "stream_url": self.result.get("stream_url"),
                "status_url": self.result.get("status_url"),
                "has_video": "video_path" in self.result,
                "has_events": "events_path" in self.result,
            }
        return value


class VideoJobStore:
    def __init__(self) -> None:
        self.videos: dict[str, VideoRecord] = {}
        self.jobs: dict[str, VideoJob] = {}
        self.lock = threading.RLock()

    def video(self, video_id: str) -> VideoRecord:
        with self.lock:
            record = self.videos.get(video_id)
        if record is None or not record.path.is_file():
            raise KeyError(video_id)
        return record

    def job(self, job_id: str) -> VideoJob:
        with self.lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return job


def _store(request: Request) -> VideoJobStore:
    return request.app.state.video_jobs


def _validate_video(path: Path) -> None:
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened() or int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) <= 0:
            raise ValueError("Uploaded file is not a readable video")
    finally:
        capture.release()


@router.post("/upload", status_code=201)
def upload_video(request: Request, file: Annotated[UploadFile, File()]):
    extension = Path(file.filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, "Unsupported video format; use MP4, MOV, AVI, or MKV")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    video_id = uuid.uuid4().hex
    destination = UPLOAD_DIR / f"{video_id}{extension}"
    size = 0
    try:
        with destination.open("wb") as output:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Video exceeds the 2 GB upload limit")
                output.write(chunk)
        if not size:
            raise HTTPException(400, "Uploaded video is empty")
        _validate_video(destination)
    except HTTPException:
        destination.unlink(missing_ok=True)
        raise
    except (OSError, ValueError) as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(400, str(exc)) from exc
    finally:
        file.file.close()
    record = VideoRecord(video_id, Path(file.filename or "video").name, destination, datetime.now(UTC).isoformat())
    store = _store(request)
    with store.lock:
        store.videos[video_id] = record
    return {"video_id": video_id, "filename": record.filename, "status": "ready"}


@router.post("/{video_id}/run", status_code=202)
def run_video(video_id: str, payload: RunVideoRequest, request: Request):
    store = _store(request)
    try:
        store.video(video_id)
    except KeyError as exc:
        raise HTTPException(404, "Unknown video_id") from exc
    job = VideoJob(uuid.uuid4().hex, video_id, payload.pipeline_type, "processing", datetime.now(UTC).isoformat())
    with store.lock:
        store.jobs[job.job_id] = job
    thread = threading.Thread(target=_execute_job, args=(request.app, job.job_id), name=f"video-job-{job.job_id[:8]}", daemon=True)
    thread.start()
    return job.public()


@router.get("/jobs/{job_id}")
def job_status(job_id: str, request: Request):
    try:
        payload = _store(request).job(job_id).public()
        progress_file = JOB_DIR / job_id / "progress.json"
        if payload["status"] == "processing" and progress_file.is_file():
            try:
                payload.update(json.loads(progress_file.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                pass
        return payload
    except KeyError as exc:
        raise HTTPException(404, "Unknown job_id") from exc


def _job_file(request: Request, job_id: str, key: str, media_type: str):
    try:
        job = _store(request).job(job_id)
    except KeyError as exc:
        raise HTTPException(404, "Unknown job_id") from exc
    if job.status != "completed" or not job.result or key not in job.result:
        raise HTTPException(409, "Job output is not ready")
    path = Path(job.result[key])
    if not path.is_file():
        raise HTTPException(404, "Job output file is missing")
    return FileResponse(path, media_type=media_type)


@router.get("/jobs/{job_id}/video")
def job_video(job_id: str, request: Request):
    return _job_file(request, job_id, "video_path", "video/mp4")


@router.get("/jobs/{job_id}/events")
def job_events(job_id: str, request: Request):
    response = _job_file(request, job_id, "events_path", "application/json")
    return response


@router.get("/jobs/{job_id}/summary")
def job_summary(job_id: str, request: Request):
    try:
        job = _store(request).job(job_id)
    except KeyError as exc:
        raise HTTPException(404, "Unknown job_id") from exc
    if job.status != "completed" or not job.result:
        raise HTTPException(409, "Job output is not ready")
    return job.result.get("summary", {})


def _execute_job(app, job_id: str) -> None:
    store: VideoJobStore = app.state.video_jobs
    job = store.job(job_id)
    video = store.video(job.video_id)
    output = JOB_DIR / job.job_id
    output.mkdir(parents=True, exist_ok=True)
    try:
        if job.pipeline_type == "anpr":
            app.state.anpr_stream.replace_video(video.path)
            result = {"stream_url": "/api/anpr/stream", "status_url": "/api/anpr/status"}
        elif job.pipeline_type == "traffic_analytics":
            command = [sys.executable, str(ROOT / "scripts" / "run_traffic_signal_demo.py"), "--video", str(video.path),
                       "--config", str(ROOT / "configs" / "traffic_signal_1.json"), "--output-dir", str(output),
                       "--detector", "bmd45", "--tracker", "bytetrack", "--imgsz", "640", "--max-width", "1280",
                       "--frame-stride", "3",
                       "--progress-file", str(output / "progress.json"), "--no-display",
                       "--write-video", "--write-json", "--hide-approach-regions"]
            subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
            source_video = output / "traffic_signal_annotated.mp4"
            browser_video = output / "traffic_signal_annotated.browser.mp4"
            _transcode(source_video, browser_video)
            browser_video.replace(source_video)
            events = output / "traffic_state_events.json"
            summary_path = output / "unique_vehicle_classes.json"
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            result = {"video_path": str(source_video), "events_path": str(events), "summary": summary}
        else:
            command = [sys.executable, str(ROOT / "emergency-alert" / "run_accident_demo.py"), "--video", str(video.path),
                       "--output-dir", str(output), "--camera-id", f"UPLOAD-{video.video_id[:8].upper()}",
                       "--no-display", "--no-publish"]
            subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
            events = output / "accident_events.json"
            summary = json.loads(events.read_text(encoding="utf-8"))
            result = {"video_path": str(output / "accident_annotated.mp4"), "events_path": str(events), "summary": summary}
        with store.lock:
            job.status, job.result = "completed", result
    except Exception as exc:  # noqa: BLE001 - worker failures must be persisted for polling clients
        with store.lock:
            job.status, job.error = "failed", str(exc)


def _transcode(source: Path, destination: Path) -> None:
    import imageio_ffmpeg

    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-v", "error", "-i", str(source), "-an",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(destination)], check=True)
