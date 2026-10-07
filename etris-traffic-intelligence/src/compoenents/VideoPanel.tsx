import { useEffect, useRef } from "react";
import type { TrafficCamera } from "../types/traffic";
type Props = { scene: TrafficCamera; onPlaybackChange?: (currentTime: number, isPlaying: boolean) => void };
export default function VideoPanel({ scene, onPlaybackChange }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const emit = () => { const v = ref.current; if (v) onPlaybackChange?.(v.currentTime, !v.paused && !v.ended); };
  useEffect(() => { ref.current?.load(); onPlaybackChange?.(0, false); }, [scene.id, onPlaybackChange]);
  return <section><h2>Annotated perception feed</h2><video key={scene.id} ref={ref} src={scene.video} controls muted playsInline preload="metadata"
    onTimeUpdate={emit} onPlay={emit} onPause={emit} onSeeking={emit} onSeeked={emit} onLoadedMetadata={emit} onEnded={emit}/>
    <p>Traffic analytics and adaptive signal recommendations are synchronized to recorded video time.</p></section>;
}
