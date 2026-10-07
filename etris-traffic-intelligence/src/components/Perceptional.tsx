import type { TrafficCamera } from "../types/traffic";
export default function Perceptional({ perception }: { perception: TrafficCamera["perception"] }) {
  const rows = [["Unique Tracked Vehicles", perception.vehicles], ["Cars", perception.cars], ["Motorcycles", perception.motorcycles],
    ["Auto-rickshaws", perception.autos], ["Buses", perception.buses], ["Trucks", perception.trucks], ["Others", perception.others]];
  return <section><h2>Whole-video perception</h2><div className="metrics">{rows.map(([label,value]) =>
    <div className="metric" key={label}><small>{label}</small><strong>{value}</strong></div>)}</div></section>;
}
