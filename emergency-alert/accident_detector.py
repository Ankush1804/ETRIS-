"""Fused accident-specific and vehicle-temporal accident detection."""
from __future__ import annotations

import argparse, json, math, subprocess, time
from collections import defaultdict, deque
from pathlib import Path
import cv2
import imageio_ffmpeg
import requests
import torch
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VIDEO = ROOT / "cv/data/video/accident1.mp4"
DEFAULT_MODEL = ROOT / "weights/epoch61.pt"
VEHICLE_MODEL = ROOT / "weights/yolo26n.pt"
DEFAULT_OUTPUT = ROOT / "runs/accident_test"
VEHICLE_CLASSES = [2, 3, 5, 7]


def center(b): return ((b[0]+b[2])/2, (b[1]+b[3])/2)
def diagonal(b): return math.hypot(b[2]-b[0], b[3]-b[1])


def iou(a, b):
    x1, y1, x2, y2 = max(a[0],b[0]), max(a[1],b[1]), min(a[2],b[2]), min(a[3],b[3])
    inter = max(0.,x2-x1)*max(0.,y2-y1)
    aa, ab = max(0.,a[2]-a[0])*max(0.,a[3]-a[1]), max(0.,b[2]-b[0])*max(0.,b[3]-b[1])
    return inter/max(aa+ab-inter, 1e-6)


def gap(a, b):
    dx, dy = max(a[0]-b[2],b[0]-a[2],0.), max(a[1]-b[3],b[1]-a[3],0.)
    return math.hypot(dx,dy)


def expanded_iou(a, b, factor=.12):
    def expand(x):
        px, py = (x[2]-x[0])*factor, (x[3]-x[1])*factor
        return (x[0]-px,x[1]-py,x[2]+px,x[3]+py)
    return iou(expand(a),expand(b))


class LogicalAssociator:
    """Reassociates nearby, class-compatible replacement track IDs for a short TTL."""
    def __init__(self, ttl):
        self.ttl, self.next_id, self.raw_map, self.memory = ttl, 1, {}, {}

    def assign(self, raw, box, cls_id, frame, active):
        logical = self.raw_map.get(raw)
        if logical is None:
            candidates=[]
            for old,(lid,old_box,old_cls,last) in self.memory.items():
                if old in active or old_cls != cls_id or not 0 < frame-last <= self.ttl: continue
                overlap=iou(box,old_box)
                proximity=math.dist(center(box),center(old_box))/max(diagonal(box),diagonal(old_box),1.)
                if overlap >= .08 or proximity <= .55: candidates.append((overlap-.25*proximity,lid))
            if candidates: logical=max(candidates)[1]
            else: logical,self.next_id=self.next_id,self.next_id+1
            self.raw_map[raw]=logical
        self.memory[raw]=(logical,box,cls_id,frame)
        return logical

    def prune(self, frame):
        for raw in [r for r,v in self.memory.items() if frame-v[3] > self.ttl]:
            self.memory.pop(raw,None); self.raw_map.pop(raw,None)


def choose_device(value):
    if value == "auto": return 0 if torch.cuda.is_available() else "cpu"
    return int(value) if value.isdigit() else value


class AccidentPublisher:
    """HTTP publisher with >75 trigger, >=60 latch, and per-video deduplication."""
    def __init__(self, backend_url, camera_id, incident_key, enabled=True):
        self.url=backend_url.rstrip("/")+"/api/alerts/accident"
        self.camera_id=camera_id; self.incident_key=incident_key
        self.enabled=enabled; self.latched=False; self.published=False; self.alert_id=None

    def observe(self, event):
        score=float(event["score"])
        if self.latched and score < 60: self.latched=False
        if score <= 75 or self.latched: return
        self.latched=True
        if not self.enabled or self.published: return
        payload={"incident_key":self.incident_key,"camera_id":self.camera_id,"fused_score":score,"threshold":75,
            "accident_model_confidence":event["accident_model_confidence"],"video_time_s":event["video_time_s"],
            "frame_index":event["frame_index"],"accident_state":event["state"],"reason_codes":event["reason_codes"],
            "vehicle_ids":event["vehicle_ids"],"logical_vehicle_ids":event["logical_vehicle_ids"],
            "evidence_video_url":"/api/alerts/accident/evidence","source":"ACCIDENT_DETECTION"}
        try:
            response=requests.post(self.url,json=payload,timeout=5); response.raise_for_status()
            body=response.json(); self.alert_id=body["alert"]["alert_id"]; self.published=True
            print(f"Published critical accident alert {self.alert_id}")
        except requests.RequestException as error:
            print(f"WARNING: backend alert publishing failed; inference continues: {error}")


def analyze(video, model_path, output_dir, device="auto", max_frames=None, display=False,
            backend_url="http://127.0.0.1:8000", publish=True, camera_id="ACCIDENT-CAM-01"):
    video, model_path, output_dir = Path(video).resolve(), Path(model_path).resolve(), Path(output_dir).resolve()
    for path in (video,model_path,VEHICLE_MODEL):
        if not path.is_file(): raise FileNotFoundError(f"Required file not found: {path}")
    output_dir.mkdir(parents=True,exist_ok=True)
    video_out, json_out = output_dir/"accident_annotated.mp4", output_dir/"accident_events.json"
    selected_device=choose_device(str(device))
    accident_model, vehicle_model = YOLO(str(model_path)), YOLO(str(VEHICLE_MODEL))
    names=accident_model.names
    accident_ids={int(k) for k,v in names.items() if any(w in str(v).lower() for w in ("accident","crash","collision"))}
    if not accident_ids: raise RuntimeError(f"No accident-related class in model.names: {names}")
    print(f"Accident model: {model_path}\nClasses: {names}")

    cap=cv2.VideoCapture(str(video))
    if not cap.isOpened(): raise RuntimeError(f"Could not open video: {video}")
    fps=cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0: raise RuntimeError("Invalid video FPS metadata")
    width,height,total=int(cap.get(3)),int(cap.get(4)),int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {video}\nFPS: {fps:.3f}; frames: {total}")
    writer=cv2.VideoWriter(str(video_out),cv2.VideoWriter_fourcc(*"mp4v"),fps,(width,height))
    if not writer.isOpened(): raise RuntimeError(f"Could not create: {video_out}")
    incident_key=f"{camera_id}:{video.name}:{total}:{video.stat().st_mtime_ns}"
    publisher=AccidentPublisher(backend_url,camera_id,incident_key,publish)

    temporal=max(2,round(fps*.6)); post=max(2,round(fps*.75))
    aliases=LogicalAssociator(max(2,round(fps*.5)))
    histories=defaultdict(lambda:deque(maxlen=temporal+post+2)); contacts={}
    events=[]; strongest=None; confirmed=False; processed=0; started=time.perf_counter()
    while True:
        ok,frame=cap.read()
        if not ok or (max_frames is not None and processed >= max_frames): break
        fi,t=processed,processed/fps
        ar=accident_model.predict(frame,device=selected_device,imgsz=640,conf=.05,verbose=False)[0]
        accident_conf=0.; accident_boxes=[]
        if ar.boxes is not None:
            for box in ar.boxes:
                if int(box.cls[0]) in accident_ids:
                    c=float(box.conf[0]); accident_conf=max(accident_conf,c)
                    accident_boxes.append(tuple(map(float,box.xyxy[0].cpu().tolist())))

        vr=vehicle_model.track(frame,persist=True,device=selected_device,classes=VEHICLE_CLASSES,conf=.15,tracker="bytetrack.yaml",verbose=False)[0]
        vehicles={}
        if vr.boxes is not None and vr.boxes.id is not None:
            raws=vr.boxes.id.cpu().numpy().astype(int).tolist(); boxes=vr.boxes.xyxy.cpu().numpy().tolist(); classes=vr.boxes.cls.cpu().numpy().astype(int).tolist(); active=set(raws)
            for raw,b,cls_id in zip(raws,boxes,classes):
                b=tuple(map(float,b)); lid=aliases.assign(raw,b,cls_id,fi,active)
                vehicles[lid]={"raw":raw,"box":b}
        aliases.prune(fi)

        best=None; lids=list(vehicles)
        for n,id1 in enumerate(lids):
            for id2 in lids[n+1:]:
                b1,b2=vehicles[id1]["box"],vehicles[id2]["box"]
                ov,ex,g=iou(b1,b2),expanded_iou(b1,b2),gap(b1,b2)
                ng=g/max((diagonal(b1)+diagonal(b2))/2,1.); key=tuple(sorted((id1,id2)))
                h=histories[key]; h.append((fi,ng)); old=h[0]; dt=max((fi-old[0])/fps,1/fps)
                closing=max(0.,(old[1]-ng)/dt)
                rates=[(a[1]-b[1])/max((b[0]-a[0])/fps,1/fps) for a,b in zip(h,list(h)[1:])]
                change=0.
                if len(rates)>=4:
                    half=len(rates)//2; change=abs(sum(rates[:half])/half-sum(rates[half:])/max(len(rates)-half,1))
                contact=ov>0 or ex>0 or ng<=.12
                if contact and key not in contacts: contacts[key]=(fi,closing)
                slowdown=0.; candidate=contacts.get(key)
                if candidate and fi-candidate[0]>=post and (ng<=.18 or ov>0): slowdown=min(1.,max(0.,candidate[1]-closing)/.8+.35)
                union=(min(b1[0],b2[0]),min(b1[1],b2[1]),max(b1[2],b2[2]),max(b1[3],b2[3]))
                accident_overlap=max((iou(union,x) for x in accident_boxes),default=0.)
                item={"key":key,"raw_ids":[vehicles[id1]["raw"],vehicles[id2]["raw"]],"iou":ov,"expanded":ex,"gap":g,"ngap":ng,"closing":closing,"change":change,"slowdown":slowdown,"rank":3*accident_overlap+(1 if contact else 0)-ng}
                if best is None or item["rank"]>best["rank"]: best=item

        model_part=65*accident_conf; contact_part=closing_part=impact_part=post_part=0.; reasons=[]
        if accident_conf>=.35: reasons.append("ACCIDENT_MODEL")
        if best:
            contact_part=min(12.,(6 if best["iou"]>0 else 0)+(4 if best["expanded"]>0 else 0)+(2 if best["ngap"]<=.12 else 0))
            closing_part=min(8.,8*best["closing"]); impact_part=min(5.,5*best["change"]/1.5); post_part=10*best["slowdown"]
            if contact_part: reasons.append("BOX_CONTACT_OR_NEAR_CONTACT")
            if closing_part>=2: reasons.append("RELATIVE_CLOSING_TREND")
            if impact_part>=2: reasons.append("ABRUPT_RELATIVE_MOTION_CHANGE")
            if post_part: reasons.append("POST_IMPACT_PERSISTENCE_SLOWDOWN")
        score=min(100.,model_part+contact_part+closing_part+impact_part+post_part); support=contact_part+closing_part+impact_part+post_part
        if score>=70 and accident_conf>=.65 and support>=5: state="ACCIDENT_CONFIRMED"; confirmed=True
        elif score>=45 or accident_conf>=.55: state="ACCIDENT_CANDIDATE"
        else: state="NO_ACCIDENT"

        if state!="NO_ACCIDENT":
            event={"frame_index":fi,"video_time_s":round(t,3),"state":state,"accident_model_confidence":round(accident_conf,4),"vehicle_ids":best["raw_ids"] if best else [],"logical_vehicle_ids":list(best["key"]) if best else [],"geometry":{"iou":round(best["iou"],4),"edge_gap_px":round(best["gap"],2),"normalized_gap":round(best["ngap"],4),"expanded_box_iou":round(best["expanded"],4)} if best else {},"temporal":{"closing_rate":round(best["closing"],4),"relative_motion_change":round(best["change"],4),"post_impact_slowdown":round(best["slowdown"],4)} if best else {},"score":round(score,2),"components":{"accident_model":round(model_part,2),"contact":round(contact_part,2),"closing":round(closing_part,2),"impact_motion":round(impact_part,2),"post_impact":round(post_part,2)},"reason_codes":reasons}
            events.append(event)
            if strongest is None or event["score"]>strongest["score"]: strongest=event
        publisher.observe(event if state!="NO_ACCIDENT" else {"score":score})

        color=(0,0,255) if state=="ACCIDENT_CONFIRMED" else (0,165,255) if state=="ACCIDENT_CANDIDATE" else (0,210,0)
        for lid,v in vehicles.items():
            x1,y1,x2,y2=map(int,v["box"]); cv2.rectangle(frame,(x1,y1),(x2,y2),(240,240,240),2); cv2.putText(frame,f"ID {v['raw']}/L{lid}",(x1,max(18,y1-5)),cv2.FONT_HERSHEY_SIMPLEX,.48,(255,255,255),2)
        for b in accident_boxes:
            x1,y1,x2,y2=map(int,b); cv2.rectangle(frame,(x1,y1),(x2,y2),color,3)
        cv2.rectangle(frame,(12,10),(540,112),(20,20,20),-1); cv2.putText(frame,state.replace("_"," "),(24,40),cv2.FONT_HERSHEY_SIMPLEX,.75,color,2)
        cv2.putText(frame,f"Accident model: {accident_conf:.3f}  Fused: {score:.1f}/100",(24,70),cv2.FONT_HERSHEY_SIMPLEX,.56,(255,255,255),2)
        pair="Pair: none" if not best else f"Pair L{best['key'][0]}-L{best['key'][1]} gap {best['gap']:.1f}px"
        cv2.putText(frame,pair,(24,98),cv2.FONT_HERSHEY_SIMPLEX,.5,(220,220,220),1); writer.write(frame)
        if display:
            cv2.imshow("ETRIS Accident Detection",frame)
            if cv2.waitKey(1)&0xFF==ord("q"): break
        processed+=1

    elapsed=time.perf_counter()-started; cap.release(); writer.release()
    browser_video=video_out.with_name(f"{video_out.stem}.browser.mp4")
    try:
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),"-y","-i",str(video_out),"-an","-c:v","libx264","-preset","fast","-crf","22","-pix_fmt","yuv420p","-movflags","+faststart",str(browser_video)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        browser_video.replace(video_out)
    except (OSError,subprocess.CalledProcessError) as error:
        browser_video.unlink(missing_ok=True)
        print(f"WARNING: browser-compatible H.264 conversion failed: {error}")
    if display: cv2.destroyAllWindows()
    summary={"model":str(model_path),"model_classes":names,"video":str(video),"source_fps":fps,"frames_processed":processed,"processing_fps":round(processed/elapsed,3) if elapsed else 0.,"final_classification":"ACCIDENT_CONFIRMED" if confirmed else (strongest["state"] if strongest else "NO_ACCIDENT"),"published_alert_id":publisher.alert_id,"strongest_event":strongest,"events":events}
    json_out.write_text(json.dumps(summary,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in summary.items() if k!="events"},indent=2)); print(f"Annotated video: {video_out}\nJSON events: {json_out}")
    return summary


def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument("--video",type=Path,default=DEFAULT_VIDEO); p.add_argument("--model",type=Path,default=DEFAULT_MODEL); p.add_argument("--output-dir",type=Path,default=DEFAULT_OUTPUT); p.add_argument("--device",default="auto"); p.add_argument("--backend-url",default="http://127.0.0.1:8000"); p.add_argument("--camera-id",default="ACCIDENT-CAM-01"); p.add_argument("--no-publish",action="store_true"); p.add_argument("--no-display",action="store_true"); p.add_argument("--max-frames",type=int); a=p.parse_args()
    analyze(a.video,a.model,a.output_dir,a.device,a.max_frames,not a.no_display,a.backend_url,not a.no_publish,a.camera_id)


if __name__ == "__main__": main()
