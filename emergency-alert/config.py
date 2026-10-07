import os


# ------------------------------------------------------------
# ETRIS
# ------------------------------------------------------------

ETRIS_API_URL = os.getenv(
    "ETRIS_API_URL",
    "http://127.0.0.1:8000"
)


# ------------------------------------------------------------
# Camera
# ------------------------------------------------------------

CAMERA_ID = os.getenv(
    "ETRIS_CAMERA_ID",
    "CAM-DEMO-01"
)


CAMERA_LATITUDE = float(
    os.getenv(
        "ETRIS_CAMERA_LATITUDE",
        "12.9716"
    )
)


CAMERA_LONGITUDE = float(
    os.getenv(
        "ETRIS_CAMERA_LONGITUDE",
        "77.5946"
    )
)


# ------------------------------------------------------------
# Accident model
# ------------------------------------------------------------

MODEL_PATH = os.getenv(
    "ACCIDENT_MODEL_PATH",
    "weights/yolo26n.pt"
)


# ------------------------------------------------------------
# Detection configuration
# ------------------------------------------------------------

CONFIDENCE_THRESHOLD = float(
    os.getenv(
        "ACCIDENT_CONFIDENCE_THRESHOLD",
        "0.50"
    )
)


MIN_PEAK_CONFIDENCE = float(
    os.getenv(
        "ACCIDENT_MIN_PEAK_CONFIDENCE",
        "0.90"
    )
)


MIN_DETECTIONS = int(
    os.getenv(
        "ACCIDENT_MIN_DETECTIONS",
        "5"
    )
)


MIN_CONFIDENCE_RISE = float(
    os.getenv(
        "ACCIDENT_MIN_CONFIDENCE_RISE",
        "0.20"
    )
)
