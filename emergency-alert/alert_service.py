import requests


class AlertService:

    def __init__(
        self,
        etris_api_url,
        timeout=5
    ):

        self.etris_api_url = (
            etris_api_url.rstrip("/")
        )

        self.timeout = timeout

    def send_accident_alert(
        self,
        camera_id,
        confidence,
        timestamp
    ):

        payload = {
            "type": "POSSIBLE_ACCIDENT",

            "severity": "CRITICAL",

            "status": "ACTIVE",

            "camera_id": camera_id,

            "confidence": confidence,

            "timestamp": timestamp,
        }

        response = requests.post(
            f"{self.etris_api_url}/api/alerts",
            json=payload,
            timeout=self.timeout
        )

        response.raise_for_status()

        return response.json()