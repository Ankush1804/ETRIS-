from collections import deque
from threading import RLock
from dataclasses import replace
import time
import uuid

from backend.alerts.congestion import CongestionAlertHandler, CongestionAlertPolicy
from backend.alerts.models import Alert, AlertSeverity, AlertStatus, AlertType
from backend.alerts.repository import AlertRepository
from backend.alerts.restricted_parking import RestrictedParkingAlertHandler
from backend.alerts.restricted_zone import RestrictedZoneAlertHandler


class AlertService:
    def __init__(self, repository: AlertRepository,
                 congestion_policy: CongestionAlertPolicy | None = None) -> None:
        self.repository = repository
        self.parking = RestrictedParkingAlertHandler(repository)
        self.restricted_zone = RestrictedZoneAlertHandler(repository)
        self.congestion = CongestionAlertHandler(repository, congestion_policy)
        self._accident_incidents = {}

    def process_parking_events(self, events):
        return tuple(alert for event in events if (alert := self.parking.handle(event)) is not None)

    def process_restricted_zone_events(self, events):
        return tuple(alert for event in events if (alert := self.restricted_zone.handle(event)) is not None)

    def process_congestion_snapshots(self, snapshots, *, now: float | None = None):
        """Evaluate Stage 10 CongestionResult snapshots; return emitted alerts."""
        return self.congestion.process_snapshots(tuple(snapshots), now=now)

    def process_accident(self, evidence: dict):
        """Create one standard alert per detector incident key."""
        incident_key = str(evidence["incident_key"])
        existing_id = self._accident_incidents.get(incident_key)
        if existing_id:
            existing = self.repository.get(existing_id)
            if existing is not None:
                return existing, False
        now = time.time()
        alert = Alert(
            alert_id=f"ACC-{uuid.uuid4().hex[:12].upper()}",
            alert_type=AlertType.ACCIDENT,
            severity=AlertSeverity.CRITICAL,
            status=AlertStatus.ACTIVE,
            camera_id=str(evidence["camera_id"]),
            zone_id=None, track_id=None, vehicle_class=None,
            raw_vehicle_class=None, plate=None, plate_status=None,
            started_at=now, last_updated_at=now, cleared_at=None,
            confidence=float(evidence["fused_score"]) / 100.0,
            metadata=dict(evidence),
        )
        self.repository.save(alert)
        self._accident_incidents[incident_key] = alert.alert_id
        return alert, True

    def clear_accident(self, incident_key: str):
        alert_id = self._accident_incidents.get(incident_key)
        alert = self.repository.get(alert_id) if alert_id else None
        if alert is None or alert.status is AlertStatus.CLEARED:
            return alert
        now = time.time()
        cleared = replace(alert, status=AlertStatus.CLEARED, last_updated_at=now, cleared_at=now)
        self.repository.save(cleared)
        return cleared


class CongestionRuntimeIngestor:
    """Idempotently feed distinct Stage 10 snapshot windows to one alert service."""

    def __init__(self, service: AlertService, *, history_size: int = 256) -> None:
        if history_size < 1:
            raise ValueError("history_size must be positive")
        self.service = service
        self._history_size = history_size
        self._keys = set()
        self._order = deque()
        self._lock = RLock()

    def process_once(self, snapshot_key, snapshots, *, now: float | None = None):
        with self._lock:
            if snapshot_key in self._keys:
                return ()
            self._keys.add(snapshot_key)
            self._order.append(snapshot_key)
            if len(self._order) > self._history_size:
                self._keys.remove(self._order.popleft())
            return self.service.process_congestion_snapshots(snapshots, now=now)
