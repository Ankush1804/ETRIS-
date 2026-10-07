import type { TrafficCamera, TrafficData, TrafficEvent } from '../types/traffic';
export async function loadTrafficData(): Promise<TrafficData> {
  const response = await fetch('/data/traffic_metrics.json');
  if (!response.ok) throw new Error(`Traffic analytics unavailable (${response.status})`);
  const data: TrafficData = await response.json();
  for (const id of Object.keys(data)) {
    const camera = data[id];
    if (!camera || !camera.approaches?.length) throw new Error(`Missing analytics: ${id}`);
    const values = [...Object.values(camera.perception), camera.metadata.snapshotTimeSec,
      camera.trafficState.activeVehicles, camera.trafficState.densityPercent, camera.trafficState.volume,
      camera.trafficState.queueLength, camera.trafficState.occupancy, camera.trafficState.arrivalRate,
      ...camera.approaches.flatMap(a => [a.vehicleCount, a.queueLength, a.occupancy, a.arrivalRate, a.pressure, a.priority, a.recommendedGreen])];
    if (values.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`Invalid analytics: ${id}`);
  }
  return data;
}

export async function loadTrafficEvents(path: string, signal: AbortSignal): Promise<TrafficEvent[]> {
  const response = await fetch(path, {signal, cache: 'no-store'});
  if (!response.ok) throw new Error(`Recorded analytics unavailable (${response.status})`);
  const events: TrafficEvent[] = await response.json();
  if (!events.length) throw new Error('No recorded traffic events');
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!Number.isFinite(e.video_time_s) || e.video_time_s < 0 ||
        (i > 0 && e.video_time_s < events[i-1].video_time_s) || !e.approaches.length)
      throw new Error('Invalid recorded event timeline');
    for (const a of e.approaches) {
      if ([a.vehicle_count, a.queue_length, a.occupancy, a.arrival_rate_vpm,
           a.average_waiting_time_s, a.heavy_vehicle_count, a.controller.pressure,
           a.controller.effective_priority, a.controller.green_duration_s].some(x => !Number.isFinite(x)))
        throw new Error('Invalid recorded approach values');
    }
  }
  return events;
}

// Latest event at or before the playhead; -1 means no analytics exist yet.
export function eventIndexAt(events: TrafficEvent[], time: number): number {
  let low = 0, high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].video_time_s <= time) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

export function cameraAtEvent(base: TrafficCamera, event: TrafficEvent): TrafficCamera {
  const approaches = event.approaches.map(a => {
    const flow = base.approaches.find(x => x.id === a.approach_id);
    return {id: a.approach_id, name: a.label.replaceAll('_', ' '),
      vehicleCount: a.vehicle_count, queueLength: a.queue_length, occupancy: a.occupancy,
      waitingTime: a.average_waiting_time_s, arrivalRate: a.arrival_rate_vpm,
      heavyVehicleCount: a.heavy_vehicle_count, pressure: a.controller.pressure,
      priority: a.controller.effective_priority,
      fairnessBonus: a.controller.effective_priority - a.controller.pressure,
      recommendedGreen: a.controller.green_duration_s,
      crossings: flow?.crossings ?? 0, volume: flow?.volume ?? 0, volumeUnit: 'veh/hr' as const};
  });
  const occupancy = approaches.reduce((n,a) => n+a.occupancy, 0) / approaches.length;
  const densityPercent = occupancy * 100;
  return {...base, phaseOrder: event.phase_order, approaches,
    metadata: {...base.metadata, snapshotTimeSec: event.video_time_s, snapshotType: 'videoSynchronizedEvent'},
    trafficState: {...base.trafficState,
      activeVehicles: approaches.reduce((n,a) => n+a.vehicleCount, 0),
      queueLength: approaches.reduce((n,a) => n+a.queueLength, 0),
      arrivalRate: approaches.reduce((n,a) => n+a.arrivalRate, 0), occupancy, densityPercent,
      density: densityPercent < 25 ? 'LOW' : densityPercent < 50 ? 'MODERATE' : densityPercent < 75 ? 'HIGH' : 'SEVERE'}};
}
