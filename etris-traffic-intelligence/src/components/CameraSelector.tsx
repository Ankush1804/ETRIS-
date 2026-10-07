import type { TrafficCamera } from "../types/traffic";
type Props = { scenes: TrafficCamera[]; selectedId: string; onSelect: (id: string) => void };
export default function CameraSelector({ scenes, selectedId, onSelect }: Props) {
  return <nav className="camera-selector" aria-label="Camera selector">{scenes.map(scene =>
    <button key={scene.id} onClick={() => onSelect(scene.id)} aria-pressed={scene.id === selectedId}>{scene.cameraName}</button>)}</nav>;
}
