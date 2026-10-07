import { useCallback, useEffect, useMemo, useState } from "react";
import CameraSelector from "./components/CameraSelector";
import Perceptional from "./components/Perceptional";
import SignalPanel from "./components/SignalPanel";
import VideoPanel from "./components/VideoPanel";
import { cameraAtEvent, eventIndexAt, loadTrafficData, loadTrafficEvents } from "./services/trafficData";
import type { TrafficData, TrafficEvent } from "./types/traffic";

export default function App() {
  const [data,setData] = useState<TrafficData|null>(null), [selected,setSelected] = useState("cam_1");
  const [timeline,setTimeline] = useState<{id:string;events:TrafficEvent[];index:number}|null>(null);
  const [playbackTime,setPlaybackTime] = useState(0), [isPlaying,setIsPlaying] = useState(false), [error,setError] = useState("");
  useEffect(() => { loadTrafficData().then(value => { setData(value); if (!value[selected]) setSelected(Object.keys(value)[0] ?? ""); }).catch(e => setError(e.message)); }, []);
  const base = data?.[selected];
  useEffect(() => { const abort = new AbortController(); setTimeline(null); setPlaybackTime(0); setIsPlaying(false); setError("");
    if (base) loadTrafficEvents(base.events ?? `/data/${base.id}_events.json`, abort.signal)
      .then(events => { if (!abort.signal.aborted) setTimeline({id:selected,events,index:eventIndexAt(events,0)}); })
      .catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [base,selected]);
  const handlePlaybackChange = useCallback((time:number,playing:boolean) => { setPlaybackTime(time); setIsPlaying(playing);
    setTimeline(previous => { if (!previous || previous.id !== selected) return previous; const index=eventIndexAt(previous.events,time);
      return index===previous.index ? previous : {...previous,index}; }); }, [selected]);
  const event = timeline?.id===selected && timeline.index>=0 ? timeline.events[timeline.index] : undefined;
  const scene = useMemo(() => base && event ? cameraAtEvent(base,event) : base, [base,event]);
  const scenes = data ? Object.values(data) : [];
  return <><style>{`*{box-sizing:border-box}body{margin:0;background:#0a101a;color:#e8eff8;font-family:Segoe UI,Arial,sans-serif}main{max-width:1500px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:20px;align-items:center}.badge,button{background:#14342f;color:#8be6c7;border:1px solid #28604f;border-radius:6px;padding:8px 11px}.camera-selector{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}button[aria-pressed=true]{background:#226f5b;color:white}section{background:#111c2b;border:1px solid #25364d;border-radius:10px;padding:20px;margin:14px 0}h1{margin:4px 0}h2{font-size:14px;text-transform:uppercase;letter-spacing:1px}.grid{display:grid;grid-template-columns:1.1fr 1fr;gap:14px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px}.metric{background:#0d1725;padding:12px;border-radius:7px}.metric small{color:#9db0c5;text-transform:uppercase}.metric strong{display:block;font-size:23px;margin-top:8px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{padding:11px;text-align:left;border-bottom:1px solid #25364d}.highest{background:#14342f}video{width:100%;background:#000}.error{color:#ffb5b5}@media(max-width:850px){.grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}header{align-items:flex-start;flex-direction:column}}`}</style>
    <main><header><div><small>ETRIS ULTIMATE AI</small><h1>Traffic Intelligence</h1><span className="badge">REAL VIDEO ANALYTICS · BMD-45 + TrafficByteTracker</span></div>
    <span className="badge">{isPlaying?"VIDEO-SYNCHRONIZED ANALYTICS":"PAUSED"} · {(event?.video_time_s ?? playbackTime).toFixed(1)} sec</span></header>
    {error && <section className="error" role="alert">{error}</section>}{scenes.length>0 && <CameraSelector scenes={scenes} selectedId={selected} onSelect={setSelected}/>} {!scene&&!error&&<p>Loading traffic analytics…</p>}
    {scene && <><div className="grid"><VideoPanel scene={scene} onPlaybackChange={handlePlaybackChange}/><Perceptional perception={scene.perception}/></div>
      <SignalPanel scene={scene} eventTime={event?.video_time_s ?? 0} isPlaying={isPlaying}/></>}</main></>;
}
