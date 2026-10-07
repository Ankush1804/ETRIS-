"""Preprocess real video into image-space traffic state and signal recommendations."""
import argparse
import json
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

import cv2
import numpy as np

PROJECT_ROOT=Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path: sys.path.insert(0,str(PROJECT_ROOT))

from backend.signal_control.controller import AdaptiveSignalController
from backend.signal_control.vision_adapter import approach_states_from_video
from cv.common.frame import FramePacket
from cv.traffic_state.config import load_traffic_state_config
from cv.traffic_state.extractor import TrafficStateExtractor
from cv.traffic_state.tracker import TrafficByteTracker, TrafficStateTracker


def args():
    parser = argparse.ArgumentParser(
        description="ETRIS real-video traffic-state demo (no ANPR/OCR)"
    )

    parser.add_argument("--video", required=True)
    parser.add_argument("--config", required=True)

    parser.add_argument("--output-dir", default="runs/signal_demo")
    parser.add_argument("--max-frames", type=int)

    parser.add_argument("--no-display", action="store_true")
    parser.add_argument("--write-video", action="store_true")

    parser.add_argument(
        "--write-json",
        action=argparse.BooleanOptionalAction,
        default=True,
    )

    parser.add_argument(
        "--calibration-preview",
        action="store_true",
        help="Draw configured ROIs on the first frame and exit without loading YOLO",
    )

    parser.add_argument("--device", default="cuda")

    parser.add_argument(
        "--detector",
        choices=("coco", "bmd45"),
        default="bmd45",
    )

    parser.add_argument(
        "--tracker",
        choices=("legacy", "bytetrack"),
        default="bytetrack",
    )

    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--max-width", type=int, help="Downscale wide input before inference and output encoding")
    parser.add_argument("--frame-stride", type=int, default=1, help="Analyze every Nth frame while preserving video time")
    parser.add_argument("--progress-file", type=Path, help="Write real frame progress for API clients")

    # NEW:
    # Hides approach polygons / queue polygons / entry lines ONLY
    # from the rendered video.
    # Internal traffic-state calculations still use them.
    parser.add_argument(
        "--hide-approach-regions",
        action="store_true",
        help=(
            "Hide approach polygons, queue polygons, entry lines and "
            "approach labels from annotated video while keeping "
            "all traffic-state calculations active."
        ),
    )

    return parser.parse_args()


def points(polygon,width,height): return np.asarray([[round(x*(width-1)),round(y*(height-1))] for x,y in polygon],np.int32)


def draw_regions(image, config, hide=False):
    """
    Draw approach/queue/entry-line geometry for visualization only.

    Important:
    Setting hide=True does NOT disable the approach geometry used by the
    traffic-state extractor. It only removes the visual overlays.
    """

    if hide:
        return image

    h, w = image.shape[:2]

    for index, region in enumerate(config.approaches):
        color = (80, 225, 160) if index % 2 == 0 else (255, 190, 80)

        traffic_polygon = points(
            region.traffic_polygon,
            w,
            h,
        )

        queue_polygon = points(
            region.queue_polygon,
            w,
            h,
        )

        entry_line = points(
            region.entry_line,
            w,
            h,
        )

        # Approach polygon
        cv2.polylines(
            image,
            [traffic_polygon],
            True,
            color,
            2,
        )

        # Queue polygon
        cv2.polylines(
            image,
            [queue_polygon],
            True,
            (50, 180, 255),
            2,
        )

        # Entry line
        cv2.line(
            image,
            tuple(entry_line[0]),
            tuple(entry_line[1]),
            (255, 255, 70),
            2,
        )

        # Approach label
        anchor = tuple(
            points(
                (region.traffic_polygon[0],),
                w,
                h,
            )[0]
        )

        cv2.putText(
            image,
            f"{region.approach_id} / {region.label}",
            anchor,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            color,
            2,
        )

    return image


def main():
    options=args(); video=Path(options.video); config=load_traffic_state_config(options.config)
    if options.frame_stride < 1: raise ValueError("--frame-stride must be at least 1")
    if not video.is_file(): raise FileNotFoundError(f"Video not found: {video}")
    output=Path(options.output_dir); output.mkdir(parents=True,exist_ok=True)
    capture=cv2.VideoCapture(str(video)); fps=float(capture.get(cv2.CAP_PROP_FPS)) or 30.0
    width,height=int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if options.max_width and width > options.max_width:
        scale=options.max_width/width; width,height=options.max_width,max(2,int(round(height*scale/2)*2))
    total=int(capture.get(cv2.CAP_PROP_FRAME_COUNT)); ok,first=capture.read()
    if not ok: raise RuntimeError(f"Unable to read video: {video}")
    if options.calibration_preview:
        draw_regions(first,config); path=output/"roi_calibration_preview.jpg"; cv2.imwrite(str(path),first)
        print(f"ROI preview: {path}\nNormalized config: {options.config}"); return
    capture.set(cv2.CAP_PROP_POS_FRAMES,0)
    if options.detector=="bmd45":
        from cv.traffic_state.detector import BMD45TrafficDetector
        detector=BMD45TrafficDetector(PROJECT_ROOT/"weights/traffic/bmd45-yolov12s.pt",device=options.device,image_size=options.imgsz)
    else:
        from cv.detection.ultralytics_detector import UltralyticsVehicleDetector
        detector=UltralyticsVehicleDetector(PROJECT_ROOT/"weights/yolo26n.pt",device=options.device)
    tracker=TrafficByteTracker() if options.tracker=="bytetrack" else TrafficStateTracker()
    extractor=TrafficStateExtractor(config); controller=AdaptiveSignalController()
    writer=None
    if options.write_video:
        writer=cv2.VideoWriter(str(output/"traffic_signal_annotated.mp4"),cv2.VideoWriter_fourcc(*"mp4v"),fps/options.frame_stride,(width,height))
    if options.write_video and not writer.isOpened(): raise RuntimeError("Cannot open annotated video writer")
    events=[]; stats=defaultdict(lambda:defaultdict(list)); unique=defaultdict(set); crossings=defaultdict(set)
    unique_track_classes = {}
    last_plan=None; last_phase_order=None; phase_order_changes=0; start_clock=time.perf_counter(); frame_index=0; base=datetime(2026,1,1,tzinfo=UTC)
    while options.max_frames is None or frame_index<options.max_frames:
        ok,image=capture.read()
        if not ok: break
        if image.shape[1] != width or image.shape[0] != height:
            image=cv2.resize(image,(width,height),interpolation=cv2.INTER_AREA)
        video_time=frame_index/fps; timestamp=base+timedelta(seconds=video_time)
        packet=FramePacket("SIGNAL-DEMO-CAMERA",frame_index,timestamp,image)
        detections=detector.detect(packet); tracks=tracker.update(detections); state=extractor.update(tracks,frame_index=frame_index,
            video_time_s=video_time,width=width,height=height)
        if state.controller_update_due:
            inputs=approach_states_from_video(state,config.intersection_id,timestamp)
            last_plan=controller.plan(config.intersection_id,inputs,generated_at=timestamp)
            current_order=tuple(x.approach_id for x in last_plan.ordered_phases)
            if last_phase_order is not None and current_order!=last_phase_order: phase_order_changes+=1
            last_phase_order=current_order
            decisions={x.approach_id:x for x in last_plan.ordered_phases}
            events.append({"source":"REAL_VIDEO_ESTIMATE","video_time_s":video_time,"frame_index":frame_index,
                "approaches":[{"approach_id":x.approach_id,"label":x.label,"vehicle_count":x.active_vehicle_count,
                "queue_length":x.queue_length,"occupancy":x.image_space_occupancy,"arrival_rate_vpm":x.arrival_rate_vpm,
                "average_waiting_time_s":x.average_waiting_time_s,"heavy_vehicle_count":x.heavy_vehicle_count,
                "queued_track_ids":list(x.queued_track_ids),"controller":decisions[x.approach_id].to_dict()} for x in state.approaches],
                "phase_order":[x.approach_id for x in last_plan.ordered_phases],"cycle_duration_s":last_plan.cycle_duration_s,
                "limitations":"Image-space occupancy and slow/stationary congestion estimate; not verified physical lane occupancy or red-signal queue length."})
            for item in state.approaches:
                decision=decisions[item.approach_id]; stats[item.approach_id]["pressure"].append(decision.pressure)
                stats[item.approach_id]["green"].append(decision.green_duration_s)
        for item in state.approaches:
            s=stats[item.approach_id]; s["active"].append(item.active_vehicle_count); s["occupancy"].append(item.image_space_occupancy)
            s["queue"].append(item.queue_length); s["wait"].append(item.average_waiting_time_s); s["heavy"].append(item.heavy_vehicle_count); s["arrival"].append(item.arrival_rate_vpm)
            unique[item.approach_id].update(item.active_track_ids)
        # Retain the last stabilized label before expired tracks lose evidence.
        for track in tracks:
            unique_track_classes[track.track_id] = (
                tracker.display_class(track.track_id)
                if hasattr(tracker, "display_class") else track.class_name
            )
        if writer or not options.no_display:
            draw_regions(image, config, hide=options.hide_approach_regions)
            for track in tracks:
                b = track.bbox
                queued = any(track.track_id in item.queued_track_ids for item in state.approaches)
                cv2.rectangle(image, (int(b.x1), int(b.y1)), (int(b.x2), int(b.y2)),
                              (0, 80, 255) if queued else (80, 225, 160), 2)
                label = f"#{track.track_id} {unique_track_classes[track.track_id]} {track.detection_confidence:.2f}"
                font = cv2.FONT_HERSHEY_SIMPLEX
                (tw, th), baseline = cv2.getTextSize(label, font, .6, 2)
                x = max(0, min(int(b.x1), width-tw-8))
                y = max(th+8, min(int(b.y1)-5, height-baseline-4))
                cv2.rectangle(image, (x, y-th-6), (x+tw+6, y+baseline+3), (8, 18, 24), -1)
                cv2.putText(image, label, (x+3, y), font, .6, (255, 255, 255), 2, cv2.LINE_AA)
        if writer: writer.write(image)
        if not options.no_display:
            cv2.imshow("ETRIS Traffic State Estimate",image)
            if cv2.waitKey(1)&0xFF==ord("q"): break
        for _ in range(options.frame_stride-1): capture.grab()
        frame_index+=options.frame_stride
        if options.progress_file and (frame_index == 1 or frame_index % 10 == 0):
            options.progress_file.parent.mkdir(parents=True,exist_ok=True)
            options.progress_file.write_text(json.dumps({"frames_processed":frame_index,"total_frames":total,
                "progress":min(99.,100.*frame_index/max(total,1))}),encoding="utf-8")
    elapsed=time.perf_counter()-start_clock; capture.release(); tracking=tracker.diagnostics(); tracker.finalize_all()
    if writer: writer.release()
    if options.progress_file:
        options.progress_file.write_text(json.dumps({"frames_processed":frame_index,"total_frames":total,"progress":100.}),encoding="utf-8")
    cv2.destroyAllWindows()
    if options.write_json: (output/"traffic_state_events.json").write_text(json.dumps(events,indent=2),encoding="utf-8")
        # ------------------------------------------------------------
    # Export unique track-level vehicle class counts.
    # Scope: tracker IDs that appeared in at least one configured
    # traffic approach. A track is counted only once.
    # ------------------------------------------------------------

    monitored_track_ids = set()

    for track_ids in unique.values():
        monitored_track_ids.update(track_ids)

    raw_class_counts = {}

    for track_id in sorted(monitored_track_ids):
        label = unique_track_classes.get(track_id, "Unknown")
        raw_class_counts[label] = raw_class_counts.get(label, 0) + 1

    perception = {
        "vehicles": len(monitored_track_ids),
        "cars": 0,
        "motorcycles": 0,
        "autos": 0,
        "buses": 0,
        "trucks": 0,
        "others": 0,
    }

    def perception_bucket(label):
        normalized = (
            str(label)
            .strip()
            .lower()
            .replace("_", " ")
            .replace("-", " ")
        )

        if (
            "motorcycle" in normalized
            or "motorbike" in normalized
            or "two wheeler" in normalized
            or normalized == "bike"
        ):
            return "motorcycles"

        if (
            "rickshaw" in normalized
            or "three wheeler" in normalized
            or normalized == "auto"
            or "auto rickshaw" in normalized
        ):
            return "autos"

        if "bus" in normalized:
            return "buses"

        if (
            "truck" in normalized
            or "lcv" in normalized
            or "light commercial" in normalized
        ):
            return "trucks"

        if (
            "car" in normalized
            or "sedan" in normalized
            or "hatchback" in normalized
            or "suv" in normalized
        ):
            return "cars"

        return "others"

    for label, count in raw_class_counts.items():
        perception[perception_bucket(label)] += count

    duration = min(frame_index,total) / fps
    approach_flows = {}
    for approach in config.approaches:
        count = extractor.entry_crossing_count(approach.approach_id)
        approach_flows[approach.approach_id] = {
            "crossings": count,
            "volume": count * 3600 / duration if duration > 0 else None,
            "volumeUnit": "veh/hr",
        }
    total_crossings = sum(x["crossings"] for x in approach_flows.values())
    class_summary = {
        "source": "BMD-45 + TrafficByteTracker",
        "counting_method": "unique_track_id",
        "processed_video_duration_seconds": duration,
        "frames_processed": frame_index,
        "config": str(Path(options.config)),
        "approach_flows": approach_flows,
        "crossings": total_crossings,
        "volume": total_crossings * 3600 / duration if duration > 0 else None,
        "volumeUnit": "veh/hr",
        "peakDemandSnapshot": max(events, key=lambda event: sum(
            a["controller"]["pressure"] for a in event["approaches"])),
        "controller_limits": {"minGreen": controller.config.min_green_s,
                              "maxGreen": controller.config.max_green_s},
        "scope": "tracks observed inside at least one configured traffic approach",
        "unique_vehicles": len(monitored_track_ids),
        "class_counts_raw": dict(sorted(raw_class_counts.items())),
        "perception": perception,
        "tracker_diagnostics": {
            "tracks_created": tracking.tracks_created,
            "tracks_expired": tracking.tracks_expired,
        },
    }

    class_output = output / "unique_vehicle_classes.json"

    class_output.write_text(
        json.dumps(class_summary, indent=2),
        encoding="utf-8",
    )

    print(f"unique_vehicle_class_summary: {class_output}")
    print(f"unique_monitored_vehicles: {len(monitored_track_ids)}")
    print("unique_vehicle_classes:", dict(sorted(raw_class_counts.items())))
    print("perception_counts:", perception)
    print(f"video: {video}\nresolution: {width}x{height}\nsource_fps: {fps:.3f}\nframes_processed: {frame_index}\nvideo_duration_processed_s: {frame_index/fps:.3f}\nprocessing_fps: {frame_index/elapsed if elapsed else 0:.3f}")
    for approach in config.approaches:
        s=stats[approach.approach_id]; avg=lambda key:sum(s[key])/len(s[key]) if s[key] else 0
        maximum=lambda key:max(s[key],default=0)
        before,after=extractor.initialization_counts(approach.approach_id)
        print(f"{approach.approach_id}: unique_tracks={len(unique[approach.approach_id])} entry_crossings={extractor.entry_crossing_count(approach.approach_id)} initialized_before_line={before} initialized_after_line={after} mean_arrival_vpm={avg('arrival'):.2f} max_arrival_vpm={maximum('arrival'):.2f} mean_active={avg('active'):.2f} max_active={maximum('active')} mean_occupancy={avg('occupancy'):.4f} max_occupancy={maximum('occupancy'):.4f} max_queue={maximum('queue')} mean_wait={avg('wait'):.2f} max_wait={maximum('wait'):.2f} heavy_active_events={sum(s['heavy'])} mean_pressure={avg('pressure'):.3f} max_pressure={maximum('pressure'):.3f} mean_green={avg('green'):.2f} max_green={maximum('green')}")
    short_pct=(tracking.tracks_lifetime_under_5_frames/tracking.tracks_created*100) if tracking.tracks_created else 0
    print(f"tracking: tracks_created={tracking.tracks_created} tracks_expired={tracking.tracks_expired} mean_lifetime_frames={tracking.mean_track_lifetime_frames:.2f} median_lifetime_frames={tracking.median_track_lifetime_frames:.2f} under_3_frames={tracking.tracks_lifetime_under_3_frames} under_5_frames={tracking.tracks_lifetime_under_5_frames} short_lived_pct={short_pct:.2f} mean_matched_iou={tracking.mean_matched_iou:.4f} unmatched_detections_per_frame={tracking.unmatched_detections_per_frame:.3f}")
    if hasattr(detector,"raw_counts"):
        print("detections_by_raw_class:",dict(sorted(detector.raw_counts.items())))
        print("detection_zones:",{f"{raw}:{zone}":count for (raw,zone),count in sorted(detector.zone_counts.items())})
    try:
        import torch
        print(f"peak_cuda_vram_mb: {torch.cuda.max_memory_allocated()/1048576:.1f}" if torch.cuda.is_available() else "peak_cuda_vram_mb: unavailable")
    except ImportError: print("peak_cuda_vram_mb: unavailable")
    print(f"plan_updates: {len(events)} phase_order_changes: {phase_order_changes}")


if __name__=="__main__": main()
