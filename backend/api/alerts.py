from pathlib import Path
from dataclasses import replace
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.alerts.models import AlertStatus, AlertType
from cv.alerts.restricted_parking import ParkingEvent, ParkingState

router=APIRouter(prefix="/api/alerts",tags=["alerts"])
ROOT = Path(__file__).resolve().parents[2]
ACCIDENT_EVIDENCE = ROOT / "runs" / "accident_test" / "accident_annotated.mp4"
PARKING_EVIDENCE = ROOT / "runs" / "stage12a_traffic2_full" / "restricted_parking_annotated.mp4"


class AccidentIngest(BaseModel):
    incident_key: str = Field(min_length=1, max_length=160)
    camera_id: str = Field(default="ACCIDENT-CAM-01", min_length=1, max_length=80)
    fused_score: float = Field(gt=75, le=100)
    threshold: float = 75
    accident_model_confidence: float = Field(ge=0, le=1)
    video_time_s: float = Field(ge=0)
    frame_index: int = Field(ge=0)
    accident_state: str
    reason_codes: list[str] = []
    vehicle_ids: list[int] = []
    logical_vehicle_ids: list[int] = []
    evidence_video_url: str = "/api/alerts/accident/evidence"
    source: str = "ACCIDENT_DETECTION"


class AccidentReset(BaseModel):
    incident_key: str


class RestrictedParkingIngest(BaseModel):
    camera_id: str
    zone_id: str
    zone_label: str | None = None
    track_id: int
    state: ParkingState
    source_time_s: float = Field(ge=0)
    frame_index: int | None = Field(default=None, ge=0)
    vehicle_class: str
    raw_vehicle_class: str | None = None
    class_confidence: float | None = Field(default=None, ge=0, le=1)
    detection_confidence: float = Field(ge=0, le=1)
    entered_zone_at: float | None = None
    stationary_since: float | None = None
    violation_started_at: float | None = None
    stationary_seconds: float = Field(ge=0)
    surface_class: str = "POLICY_DEFINED"
    raw_surface_class: str | None = None
    surface_confidence: float = Field(default=1, ge=0, le=1)
    restricted_overlap: float = Field(ge=0, le=1)
    ground_contact_fraction: float = Field(gt=0, le=1)
    motion_score: float = Field(ge=0)
    policy_mode: str = "POLICY_DEFINED"
    rule_version: str = "RPZ-2.0"
    decision_confidence: str = "LOW"
    decision_reason_codes: list[str] = []


def _filters(alert_type,status):
    try:
        return (AlertType(alert_type) if alert_type else None,AlertStatus(status) if status else None)
    except ValueError as error: raise HTTPException(422,str(error)) from error


@router.get("")
def alerts(request:Request,alert_type:str|None=None,status:str|None=None,camera_id:str|None=None,zone_id:str|None=None):
    kind,state=_filters(alert_type,status)
    return [x.to_dict() for x in request.app.state.alert_repository.list(alert_type=kind,status=state,camera_id=camera_id,zone_id=zone_id)]


@router.get("/active")
def active(request:Request,alert_type:str|None=None,camera_id:str|None=None,zone_id:str|None=None):
    kind,_=_filters(alert_type,None); rows=request.app.state.alert_repository.list(alert_type=kind,camera_id=camera_id,zone_id=zone_id)
    return [x.to_dict() for x in rows if x.status is not AlertStatus.CLEARED]


@router.post("/accident")
def ingest_accident(payload: AccidentIngest, request: Request):
    alert, created = request.app.state.alert_service.process_accident(payload.model_dump())
    return {"created": created, "alert": alert.to_dict()}


@router.post("/accident/reset")
def reset_accident(payload: AccidentReset, request: Request):
    alert = request.app.state.alert_service.clear_accident(payload.incident_key)
    return {"cleared": alert is not None, "alert": alert.to_dict() if alert else None}


@router.get("/accident/evidence")
def accident_evidence():
    if not ACCIDENT_EVIDENCE.is_file():
        raise HTTPException(404, "Accident evidence video is not available")
    return FileResponse(ACCIDENT_EVIDENCE, media_type="video/mp4", filename="accident_annotated.mp4")


@router.post("/restricted-parking")
def ingest_restricted_parking(payload: RestrictedParkingIngest, request: Request):
    data = payload.model_dump()
    event_fields = ParkingEvent.__dataclass_fields__
    event = ParkingEvent(**{key: value for key, value in data.items() if key in event_fields})
    emitted = request.app.state.alert_service.process_parking_events((event,))
    alert = emitted[0] if emitted else None
    if alert is not None:
        metadata = dict(alert.metadata)
        metadata.update({
            "zone_label": payload.zone_label or payload.zone_id.replace("_", " "),
            "video_time_s": payload.source_time_s,
            "frame_index": payload.frame_index,
            "occupancy_percent": payload.restricted_overlap * 100.0,
            "evidence_url": "/api/alerts/restricted-parking/evidence",
            "source": "RESTRICTED_PARKING_DETECTION",
        })
        alert = replace(alert, metadata=metadata)
        request.app.state.alert_repository.save(alert)
    return {"emitted": alert is not None, "alert": alert.to_dict() if alert else None}


@router.get("/restricted-parking/evidence")
def restricted_parking_evidence():
    if not PARKING_EVIDENCE.is_file():
        raise HTTPException(404, "Restricted-parking evidence video is not available")
    return FileResponse(PARKING_EVIDENCE, media_type="video/mp4", filename="restricted_parking_annotated.mp4")


@router.get("/{alert_id}")
def by_id(alert_id:str,request:Request):
    item=request.app.state.alert_repository.get(alert_id)
    if item is None: raise HTTPException(404,"Alert not found")
    return item.to_dict()
