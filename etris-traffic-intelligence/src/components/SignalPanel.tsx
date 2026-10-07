import type { TrafficCamera } from "../types/traffic";
export default function SignalPanel({ scene, eventTime, isPlaying }: { scene: TrafficCamera; eventTime: number; isPlaying: boolean }) {
  const s = scene.trafficState;
  const best = scene.approaches.find(a => a.id === scene.phaseOrder?.[0]) ?? [...scene.approaches].sort((a,b) => b.priority-a.priority)[0];
  const metrics: [string,string|number][] = [["Active Vehicles",s.activeVehicles],["Occupancy-Derived Density",s.density],
    ["Density %",`${s.densityPercent.toFixed(1)}%`],["Queue Length",s.queueLength],["Road Occupancy",`${(s.occupancy*100).toFixed(1)}%`],
    ["Arrival Rate",`${s.arrivalRate.toFixed(1)} veh/min`]];
  return <><section><h2>Current traffic state</h2><span className="badge">{isPlaying ? "VIDEO-SYNCHRONIZED ANALYTICS" : "PAUSED"} · {eventTime.toFixed(1)} sec</span>
    <div className="metrics">{metrics.map(([label,value]) => <div className="metric" key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    <h3>Whole-video flow</h3><p>Observed crossings: {s.crossings} · Estimated flow rate: {s.volume.toFixed(1)} {s.volumeUnit}</p></section>
    <section><h2>Current adaptive signal recommendation</h2><div className="table-wrap"><table><thead><tr><th>Approach</th><th>Vehicles</th><th>Queue</th><th>Occupancy</th><th>Arrival</th><th>Pressure</th><th>Priority</th><th>Green</th></tr></thead>
    <tbody>{scene.approaches.map(a => <tr key={a.id} className={a.id===best.id?"highest":""}><td>{a.name}</td><td>{a.vehicleCount}</td><td>{a.queueLength}</td><td>{(a.occupancy*100).toFixed(1)}%</td><td>{a.arrivalRate.toFixed(1)}</td><td>{a.pressure.toFixed(3)}</td><td>{a.priority.toFixed(3)}</td><td>{a.recommendedGreen} sec</td></tr>)}</tbody></table></div>
    <p><strong>Recommended phase:</strong> {best.name} · <strong>Recommended green:</strong> {best.recommendedGreen} sec</p></section></>;
}
