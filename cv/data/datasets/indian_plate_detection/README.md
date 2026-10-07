---
license: cc-by-4.0
task_categories:
  - object-detection
language:
  - en
tags:
  - anpr
  - alpr
  - license-plate
  - indian-plates
  - yolo
  - traffic
size_categories:
  - 1K<n<10K
---

# Indian Vehicle License Plate Localization (YOLO Format)

Part of the **Edge-AI Traffic & Vehicle Analytics System** repository by `thundarstrom`.

## Dataset Summary
High-precision bounding box dataset containing **3,742 deduplicated real Indian vehicle images** for license plate detection and localization in crowded traffic.

### Composition
* Perfect Indian Plates (1,844 images)
* DashCop 2K Dashcam Crops (1,123 images)
* Cleaned VOC Rescued Subset (47 images)
* Merged and verified with zero train/test hash leakage.

### Splits
* **Train**: 2,993 images (80%)
* **Validation**: 374 images (10%)
* **Test**: 375 images (10%)

---

## How to Access and Download

### Using Automated Project Downloader (Extracts automatically)
```bash
# Clone / pull and auto-extract dataset
python scripts/download_hf_datasets.py --dataset plate_detection --org thundarstrom
```

### Using `huggingface_hub` Python SDK
```python
from huggingface_hub import snapshot_download

# Download into local dataset directory
local_path = snapshot_download(
    repo_id="thundarstrom/indian-license-plate-detection",
    repo_type="dataset",
    local_dir="data/datasets/plate_detection_combined"
)
print(f"Dataset downloaded to: {local_path}")
```

---

## Recommended Training / Evaluation Recipe

```bash
python scripts/train_models.py --task plate --model yolov8n.pt --epochs 150 --imgsz 640 --batch 16
```

---

## Citation & Maintainer
* **Maintained by**: `thundarstrom`
* **Project**: Edge-AI Real-Time Traffic Violation Detection & ANPR
* **License**: CC-BY-4.0
