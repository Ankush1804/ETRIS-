export interface Approach {
  id: string; name: string; vehicleCount: number; queueLength: number;
  occupancy: number; waitingTime: number; arrivalRate: number; heavyVehicleCount: number;
  pressure: number; fairnessBonus: number; priority: number; recommendedGreen: number;
  crossings: number; volume: number; volumeUnit: 'veh/hr';
}
export interface TrafficCamera {
  id: string; cameraName: string; video: string; events?: string; phaseOrder?: string[];
  metadata: { source: string; detector: string; snapshotType: string; snapshotTimeSec: number;
    densityMethod: string; densityLabel: string; vehicleCountingMethod: string; processedDurationSec: number };
  perception: { vehicles: number; cars: number; motorcycles: number; autos: number; buses: number; trucks: number; others: number };
  trafficState: {activeVehicles: number; density: 'LOW'|'MODERATE'|'HIGH'|'SEVERE'; densityPercent: number;
    volume: number; volumeUnit: 'veh/hr'; crossings: number; queueLength: number; occupancy: number;
    arrivalRate: number; congestion: string | null};
  approaches: Approach[];
}
export type TrafficData = Record<string, TrafficCamera>;

export interface TrafficEvent {
  video_time_s: number;
  frame_index: number;
  phase_order?: string[];
  approaches: {
    approach_id: string; label: string; vehicle_count: number; queue_length: number;
    occupancy: number; arrival_rate_vpm: number; average_waiting_time_s: number;
    heavy_vehicle_count: number;
    controller: {pressure: number; effective_priority: number; green_duration_s: number};
  }[];
}
