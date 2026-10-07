"""Process recorded cameras once each; publish synchronized video and real analytics.

Default sources: UI/public/videos/cam_1.mp4 through cam_4.mp4.
CAM 1/2/3 use the established traffic_1/5/3 configs. CAM 4 requires
configs/traffic_signal_cam_4.json, or an explicit --cam4-config path.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT.parent / 'ETRIS Traffic Intelligence'


def publish(camera, config, output):
    from export_traffic_intelligence_metrics import camera_metrics
    import imageio_ffmpeg
    summary = json.loads((output / 'unique_vehicle_classes.json').read_text())
    events = json.loads((output / 'traffic_state_events.json').read_text())
    target = UI / f'public/videos/{camera}_annotated.mp4'
    temporary = target.with_name(target.stem + '.pending.mp4')
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-v', 'error', '-i',
        str(output / 'traffic_signal_annotated.mp4'), '-an', '-c:v', 'libx264',
        '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        str(temporary)], check=True)
    temporary.replace(target)
    shutil.copy2(output / 'traffic_state_events.json', UI / f'public/data/{camera}_events.json')
    shutil.copy2(output / 'unique_vehicle_classes.json', UI / f'public/data/{camera}_unique_vehicle_classes.json')
    metrics_path = UI / 'public/data/traffic_metrics.json'
    metrics = json.loads(metrics_path.read_text(encoding='utf-8-sig')) if metrics_path.exists() else {}
    metrics[camera] = camera_metrics(camera, summary, events[0])
    metrics[camera]['cameraName'] = 'CAM ' + camera.rsplit('_', 1)[1]
    metrics[camera]['video'] = f'/videos/{camera}_annotated.mp4'
    metrics[camera]['events'] = f'/data/{camera}_events.json'
    metrics[camera]['rawVideo'] = f'/videos/{camera}.mp4'
    metrics[camera]['metadata']['config'] = str(config)
    metrics[camera]['metadata']['snapshotType'] = 'videoSynchronizedEvent'
    temp = metrics_path.with_suffix('.pending.json')
    temp.write_text(json.dumps(metrics, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    temp.replace(metrics_path)
    print(f'Published {camera}: {len(events)} real events; {target}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cameras', nargs='+', type=int, choices=(1,2,3,4), default=[1,2,3,4])
    parser.add_argument('--cam4-config', type=Path, default=ROOT/'configs/traffic_signal_cam_4.json')
    options = parser.parse_args()
    # The normal system Python is CPU-only here; use the existing CUDA environment.
    python = ROOT / '.venv/Scripts/python.exe'
    if not python.is_file(): python = Path(sys.executable)
    if Path(sys.executable).resolve() != python.resolve():
        subprocess.run([str(python), str(Path(__file__).resolve()), *sys.argv[1:]], check=True)
        return
    configs = {1:ROOT/'configs/traffic_signal_1.json', 2:ROOT/'configs/traffic_signal_5.json',
               3:ROOT/'configs/traffic_signal_3.json', 4:options.cam4_config}
    jobs = [(i, UI/f'public/videos/cam_{i}.mp4', configs[i]) for i in options.cameras]
    missing = [str(p) for _, video, config in jobs for p in (video, config) if not p.is_file()]
    if missing: raise FileNotFoundError('Required camera inputs missing:\n'+'\n'.join(missing))
    for i, video, config in jobs:
        output = ROOT/f'runs/cam_{i}'
        subprocess.run([str(python), str(ROOT/'scripts/run_traffic_signal_demo.py'),
            '--video', str(video), '--config', str(config), '--output-dir', str(output),
            '--detector', 'bmd45', '--tracker', 'bytetrack', '--imgsz', '960',
            '--no-display', '--write-video', '--write-json', '--hide-approach-regions'],
            cwd=ROOT, check=True)
        publish(f'cam_{i}', config, output)


if __name__ == '__main__':
    main()
