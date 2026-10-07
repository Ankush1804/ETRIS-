"""Export coherent real-video analytics without running detection."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = Path('B:/ETRIS Traffic Intelligence/public/data/traffic_metrics.json')


def density_category(percent):
    return 'LOW' if percent < 25 else 'MODERATE' if percent < 50 else 'HIGH' if percent < 75 else 'SEVERE'


def camera_metrics(key, summary, snapshot):
    perception = summary['perception']
    assert sum(perception[k] for k in ('cars', 'motorcycles', 'autos', 'buses', 'trucks', 'others')) == perception['vehicles'] == summary['unique_vehicles']
    assert summary['counting_method'] == 'unique_track_id'
    duration = summary['processed_video_duration_seconds']
    assert duration > 0
    approaches = []
    for a in snapshot['approaches']:
        c = a['controller']
        assert summary['controller_limits']['minGreen'] <= c['green_duration_s'] <= summary['controller_limits']['maxGreen']
        flow = summary['approach_flows'][a['approach_id']]
        assert abs(flow['volume'] - flow['crossings'] * 3600 / duration) < 1e-8
        approaches.append(dict(id=a['approach_id'], name=a['label'].replace('_', ' '),
            vehicleCount=a['vehicle_count'], queueLength=a['queue_length'], occupancy=a['occupancy'],
            waitingTime=a['average_waiting_time_s'], arrivalRate=a['arrival_rate_vpm'],
            heavyVehicleCount=a['heavy_vehicle_count'], pressure=c['pressure'],
            fairnessBonus=c['effective_priority']-c['pressure'], priority=c['effective_priority'],
            recommendedGreen=c['green_duration_s'], **flow))
    occupancy = sum(a['occupancy'] for a in approaches) / len(approaches)
    assert 0 <= occupancy <= 1
    crossings = sum(a['crossings'] for a in approaches)
    assert crossings == summary['crossings']
    return dict(id=key, cameraName=key, video=f'/videos/{key}.mp4',
        metadata=dict(source='REAL_VIDEO_ESTIMATE', detector='BMD-45 + TrafficByteTracker',
            snapshotType='peakDemandSnapshot', snapshotTimeSec=snapshot['video_time_s'],
            snapshotSource=f'runs/class_export_{key}/unique_vehicle_classes.json#peakDemandSnapshot',
            
            densityMethod='mean image-space occupancy', densityLabel='Occupancy-derived traffic density',
            vehicleCountingMethod='unique track ID', processedDurationSec=duration,
            volumeMethod='observed approach entry crossings normalized to one hour',
            config=summary['config']), perception=perception,
        trafficState=dict(activeVehicles=sum(a['vehicleCount'] for a in approaches),
            density=density_category(occupancy * 100), densityPercent=occupancy * 100,
            volume=crossings * 3600 / duration, volumeUnit='veh/hr', crossings=crossings,
            queueLength=sum(a['queueLength'] for a in approaches), occupancy=occupancy,
            arrivalRate=sum(a['arrivalRate'] for a in approaches), congestion='INSUFFICIENT_DATA'),
        approaches=approaches)


def main():
    result = {}
    for i in (1, 2, 3):
        key = f"traffic_{i}"
        summary = json.loads((ROOT / f"runs/class_export_{key}/unique_vehicle_classes.json").read_text())
        result[key] = camera_metrics(key, summary, summary["peakDemandSnapshot"])
        result[key]["cameraName"] = f"Camera {i:02}"
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(f'Validated and exported {len(result)} cameras: {TARGET}')
    for key, value in result.items():
        best = min(value['approaches'], key=lambda a: (-a['priority'], a['id']))
        print(key, value['perception'], value['trafficState'], 'recommendation:', best['name'], best['recommendedGreen'], 'sec', 'snapshot:', value['metadata']['snapshotTimeSec'])


if __name__ == '__main__':
    main()
