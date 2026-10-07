(() => {
  const api = window.ETRIS_API;
  if (!api) return;
  const $ = id => document.getElementById(id);
  const asArray = value => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of ['items','results','data','events','sightings','records','cameras','trajectory','points','observations']) {
      if (Array.isArray(value[key])) return value[key];
    }
    for (const value of Object.values(value)) if (Array.isArray(value)) return value;
    return [];
  };
  const num = (...values) => { for (const v of values) { const n = Number(v); if (Number.isFinite(n)) return n; } return null; };
  const pick = (obj, keys, fallback = null) => { for (const key of keys) if (obj && obj[key] != null) return obj[key]; return fallback; };
  const text = (el, value, fallback = '—') => { if (el) el.textContent = value ?? fallback; };
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmtTime = value => {
    if (value == null || value === '') return '—';
    const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  };
  const normalizePlate = value => String(value ?? '').trim().toUpperCase().replace(/\s+/g,'');

  function eventPlate(e){return pick(e,['plate_text','plate','registration','registration_number','plate_number','text','text_norm'],'—');}
  function eventConfidence(e){const n=num(e?.confidence,e?.plate_confidence,e?.ocr_confidence,e?.score,e?.decision_confidence);return n==null?null:(n<=1?n*100:n);}
  function eventTime(e){return pick(e,['timestamp','time','captured_at','observed_at','created_at','source_time','ts'],'—');}
  function eventVehicle(e){return pick(e,['vehicle_class','class_name','vehicle_type','class','label'],'—');}
  function eventCamera(e){return pick(e,['camera_id','camera','source_camera'],'—');}
  function isVisibleRecognition(e){const plate=String(eventPlate(e)).trim().toUpperCase();const confidence=eventConfidence(e);return plate!==''&&plate!=='UNKNOWN'&&plate!=='—'&&confidence!=null&&confidence>=30;}

  async function loadHealth() {
    try { await api.health(); text($('backendStatusText'),'Backend Online'); text($('backendStatusDetail'),api.base); if($('backendPill'))$('backendPill').innerHTML='<span class="dot green"></span> Backend online'; }
    catch { text($('backendStatusText'),'Backend Offline'); text($('backendStatusDetail'),'Start FastAPI on 127.0.0.1:8000'); if($('backendPill'))$('backendPill').innerHTML='<span class="dot red"></span> Backend offline'; }
  }

  let cameraCache=[];
  async function loadCameras(){
    try {
      const raw=await api.tracking.cameras(); const rows=asArray(raw); cameraCache=rows;
      const select=$('cameraSelect');
      if(select){
        const current=select.value; select.innerHTML='<option value="">All cameras</option>';
        rows.forEach((c,i)=>{const id=pick(c,['camera_id','id','name','label'],typeof c==='string'?c:`CAM-${String(i+1).padStart(2,'0')}`);const o=document.createElement('option');o.value=id;o.textContent=id;select.appendChild(o);});
        if([...select.options].some(o=>o.value===current))select.value=current;
      }
      const grid=document.querySelector('.camera-status-grid');
      if(grid){
        if(!rows.length) grid.innerHTML='<p class="empty-state">No cameras returned by backend.</p>';
        else grid.innerHTML=rows.slice(0,8).map((c,i)=>{const id=pick(c,['camera_id','id','name','label'],typeof c==='string'?c:`CAM-${i+1}`);const status=String(pick(c,['status','state'],'AVAILABLE'));const online=!/offline|down|disabled/i.test(status);return `<div><span class="dot ${online?'green':'red'}"></span><b>${esc(id)}</b><small>${esc(status)}</small></div>`;}).join('');
      }
      return rows;
    } catch { return []; }
  }

  function setAnprMedia(mode){
    const stream=$('anprStream'), video=$('anprRecordedVideo'), fallback=$('anprMediaFallback');
    if(!stream||!video||!fallback)return;
    const recorded=/recorded|video|playback/i.test(String(mode||''));
    fallback.hidden=true;
    if(recorded){stream.hidden=true;stream.removeAttribute('src');video.hidden=false;if(!video.src)video.src=api.anpr.recordedVideoUrl();}
    else {video.hidden=true;video.pause();video.removeAttribute('src');stream.hidden=false;if(!stream.src)stream.src=api.anpr.streamUrl();}
  }

  function renderAnprEvents(events){
    const host=$('anprDetectionRows'), live=$('anprLiveRows'); if(!host||!live)return;
    const visible=events.filter(isVisibleRecognition);
    if(!visible.length){host.innerHTML='<p class="empty-state">No readable plate candidates yet.</p>';live.innerHTML='<p class="empty-state">No readable plate candidates yet.</p>';return;}
    host.innerHTML=visible.slice(0,100).map(e=>{const conf=eventConfidence(e);return `<div class="detection-item"><span>${esc(fmtTime(eventTime(e)))}</span><span>${esc(eventPlate(e))}</span><span>${esc(eventVehicle(e))}</span><span class="confidence">${conf.toFixed(1)+'%'}</span></div>`;}).join('');
    live.innerHTML=visible.slice(0,30).map(e=>{const conf=eventConfidence(e);return `<div class="live-item"><span>${esc(fmtTime(eventTime(e)))}</span><span>${esc(eventPlate(e))}</span><span><b>${conf.toFixed(1)+'%'}</b></span></div>`;}).join('');
  }

  async function loadAnpr(){
    text($('anprFeedTitle'),'ANPR FEED · CONNECTING');
    const selectedCamera=$('cameraSelect')?.value || '';
    try {
      const [statusRaw,eventsRaw,recognitionRaw,activeAlertsRaw]=await Promise.all([
        api.anpr.status().catch(()=>({})), api.anpr.events().catch(()=>[]), api.anpr.recognition().catch(()=>null), api.alerts.active().catch(()=>[])
      ]);
      const mode=pick(statusRaw,['mode','analysis_mode','state_mode'],'LIVE_ANALYSIS');
      const state=pick(statusRaw,['status','state','system_state','running'], 'ONLINE');
      const fps=num(statusRaw?.fps,statusRaw?.processing_fps,statusRaw?.current_fps);
      const latency=num(statusRaw?.inference_ms,statusRaw?.latency_ms,statusRaw?.inference_latency_ms,statusRaw?.latency);
      const events=asArray(eventsRaw);
      let filtered=events;
      if(selectedCamera) filtered=events.filter(e=>String(eventCamera(e))===selectedCamera);
      if(!filtered.length && recognitionRaw && typeof recognitionRaw==='object' && !Array.isArray(recognitionRaw)) filtered=[recognitionRaw];
      renderAnprEvents(filtered);
      text($('anprMode'),mode);text($('anprFps'),fps==null?'—':fps.toFixed(1));text($('anprInference'),latency==null?'—':`${latency.toFixed(1)}ms`);
      text($('anprSystemState'),typeof state==='boolean'?(state?'RUNNING':'STOPPED'):String(state).toUpperCase());text($('anprEventCount'),filtered.filter(isVisibleRecognition).length);
      text($('anprActiveCameras'),cameraCache.length||num(statusRaw?.active_cameras,statusRaw?.camera_count)||'—');
      text($('feedCam'),selectedCamera||pick(statusRaw,['camera_id','camera'],'All cameras'));
      text($('anprFeedTitle'),`ANPR FEED · ${String(mode).replaceAll('_',' ')}`);
      setAnprMedia(mode);
      const alerts=asArray(activeAlertsRaw);text($('anprAlertCount'),alerts.length);renderAnprAlerts(alerts,selectedCamera);
    } catch(err){
      text($('anprFeedTitle'),'ANPR FEED · BACKEND UNAVAILABLE');text($('anprSystemState'),'OFFLINE');
      if($('anprDetectionRows'))$('anprDetectionRows').innerHTML=`<p class="empty-state">ANPR API unavailable: ${esc(err.message)}</p>`;
    }
  }

  function renderAnprAlerts(alerts,camera){
    const host=$('anprAlertRows');if(!host)return;const rows=camera?alerts.filter(a=>String(pick(a,['camera_id'],'—'))===camera):alerts;
    if(!rows.length){host.innerHTML='<p class="empty-state">No active alerts returned.</p>';return;}
    host.innerHTML=rows.slice(0,8).map(a=>`<div class="blacklist-alert"><span>!</span><div><b>${esc(String(pick(a,['alert_type','type'],'ALERT')).replaceAll('_',' '))}</b><small>${esc(pick(a,['camera_id'],'—'))} · ${esc(pick(a,['status'],'ACTIVE'))}</small></div></div>`).join('');
  }

  async function anprAction(action){
    try {await api.anpr[action]();if(action==='restart'||action==='play'){const stream=$('anprStream');if(stream){stream.hidden=false;stream.src=api.anpr.streamUrl()+`?t=${Date.now()}`;}}await loadAnpr();}
    catch(err){openModal('ANPR control failed',err.message);}
  }

  function renderAnubhavEvents(raw){
    const host=$('anubhavEvents');if(!host)return;const rows=asArray(raw).filter(e=>{const status=String(pick(e,['status'],'UNKNOWN')).toUpperCase();const confidence=num(e.confidence,e.plate_confidence,e.ocr_confidence);const normalizedConfidence=confidence!=null&&confidence>1?confidence/100:confidence;return status!=='UNKNOWN'&&normalizedConfidence!=null&&normalizedConfidence>.80;});
    if(!rows.length){host.innerHTML='<p class="empty-state">No plate recognition above 80% confidence yet.</p>';return;}
    host.innerHTML=rows.slice(0,12).map(e=>{const plate=pick(e,['plate','plate_text','normalized_text','raw_text'],'UNKNOWN'),status=pick(e,['status'],'PROVISIONAL'),track=pick(e,['track_id'],'—'),rawConfidence=num(e.confidence,e.plate_confidence,e.ocr_confidence),confidence=rawConfidence>1?rawConfidence/100:rawConfidence,time=pick(e,['timestamp','detected_at'],'—');return `<div class="anubhav-event"><div><b>${esc(plate)}</b><small>Track ${esc(track)} · ${esc(fmtTime(time))}</small></div><span>${esc(status)} · ${(confidence*100).toFixed(1)}%</span></div>`;}).join('');
  }

  async function loadAnubhavAnpr(){
    const feed=api.anubhavAnpr;if(!feed){text($('anubhavBackendState'),'RELOAD');const fallback=$('anubhavMediaFallback');if(fallback)fallback.textContent='Frontend assets changed. Refresh this page once.';return;}
    try{
      const [status,events]=await Promise.all([feed.status(),feed.events().catch(()=>[])]);
      text($('anubhavBackendState'),'ONLINE');text($('anubhavPlaybackState'),String(pick(status,['playback_state','status'],status?.running?'PLAYING':'IDLE')).toUpperCase());
      const current=num(status?.current_frame,status?.frame);const total=num(status?.total_frames);text($('anubhavFrame'),current==null?'—':`${current}${total==null?'':` / ${total}`}`);
      const fps=num(status?.inference_fps,status?.fps,status?.processing_fps);text($('anubhavFps'),fps==null?'—':fps.toFixed(1));text($('anubhavFeedCam'),`${pick(status,['camera_id'],'CAM-ANUBHAV')} · port 8001`);
      const fallback=$('anubhavMediaFallback');if(fallback)fallback.hidden=true;renderAnubhavEvents(events);
    }catch(err){text($('anubhavBackendState'),'OFFLINE');text($('anubhavPlaybackState'),'OFFLINE');const fallback=$('anubhavMediaFallback');if(fallback){fallback.hidden=false;fallback.textContent='Anubhav server is offline. Run commands/anubhav_anpr_backend.txt on port 8001.';}}
  }

  async function anubhavAction(action){try{await api.anubhavAnpr[action]();await loadAnubhavAnpr();}catch(err){openModal('Anubhav ANPR control failed',err.message);}}

  async function loadAnalytics() {
    try {
      const [summary,volume,congestion]=await Promise.all([api.analytics.summary().catch(()=>({})),api.analytics.cameraVolume().catch(()=>[]),api.analytics.congestion().catch(()=>[])]);
      const rows=asArray(volume);let total=num(pick(summary,['total_vehicles','vehicle_count','unique_vehicles','total']));
      if(total==null&&rows.length)total=rows.reduce((sum,r)=>sum+(num(r.vehicle_count,r.count,r.volume,r.unique_vehicles)||0),0);
      text($('overviewVehicles'),total!=null?total.toLocaleString():'—');text($('overviewVehiclesNote'),rows.length?`${rows.length} camera-volume records`:'No camera-volume records');text($('analyticsTotalVehicles'),total!=null?total.toLocaleString():'—');
      const congestionRows=asArray(congestion);const severe=congestionRows.filter(r=>/congested|severe/i.test(String(pick(r,['state','status','level','congestion_level'],''))));text($('analyticsCongested'),severe.length||(congestionRows.length?'0':'—'));
      const ratios=congestionRows.map(r=>num(r.ratio,r.congestion_ratio,r.density,r.occupancy)).filter(v=>v!=null);if(ratios.length){const avg=ratios.reduce((a,b)=>a+b,0)/ratios.length;text($('analyticsDensity'),avg<=1?`${Math.round(avg*100)}%`:avg.toFixed(2));}else text($('analyticsDensity'),'—');renderVolumeChart(rows);
    } catch { text($('overviewVehiclesNote'),'Analytics backend unavailable'); }
  }
  function renderVolumeChart(rows){const chart=$('hourChart');if(!chart)return;if(!rows.length){chart.innerHTML='<p class="empty-state">No camera-volume data returned.</p>';return;}chart.innerHTML='';const values=rows.map(r=>num(r.vehicle_count,r.count,r.volume,r.unique_vehicles)||0),max=Math.max(...values,1);rows.slice(0,18).forEach((r,i)=>{const bar=document.createElement('i');bar.style.height=`${Math.max(4,values[i]/max*100)}%`;bar.title=`${pick(r,['camera_id','camera','label','approach_id'],`Record ${i+1}`)} · ${values[i]}`;chart.appendChild(bar);});}

  let trafficEvents=[],trafficEvents2=[],trafficSummary2={};
  function trafficEventAt(seconds,events=trafficEvents){let event=events[0]||null;for(const candidate of events){if((num(candidate.video_time_s)||0)<=seconds)event=candidate;else break;}return event;}
  function renderVehicleDistribution(perception={}){
    const donut=$('vehicleTypeDonut'),legend=$('vehicleTypeLegend');if(!donut||!legend)return;
    const values=[num(perception.cars)||0,num(perception.motorcycles)||0,num(perception.buses)||0,num(perception.trucks)||0,num(perception.autos)||0,num(perception.others)||0];
    const labels=['Car','Motorcycle','Bus','Truck','Auto','Other'],colors=['#43d17a','#f3a6b8','#f39a4a','#f06464','#3b82f6','#8b95a5'],total=values.reduce((a,b)=>a+b,0)||1;
    let cursor=0;const stops=values.map((value,index)=>{const start=cursor;cursor+=value/total*100;return `${colors[index]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;});
    donut.style.background=`conic-gradient(${stops.join(',')})`;donut.dataset.total=String(values.reduce((a,b)=>a+b,0));donut.setAttribute('aria-label',labels.map((label,i)=>`${label} ${values[i]}`).join(', '));
    legend.innerHTML=labels.map((label,i)=>`<p><i style="background:${colors[i]}"></i>${label}<b>${values[i]} · ${(values[i]/total*100).toFixed(1)}%</b></p>`).join('');
  }
  function updateTrafficModelMetrics(){
    const video=$('trafficIntelligenceVideo');if(!video)return;
    const current=video.currentTime||0,event=trafficEventAt(current);
    const approaches=Array.isArray(event?.approaches)?event.approaches:[];
    const active=approaches.reduce((sum,a)=>sum+(num(a.vehicle_count)||0),0),queue=approaches.reduce((sum,a)=>sum+(num(a.queue_length)||0),0);
    const occupancy=approaches.length?approaches.reduce((sum,a)=>sum+(num(a.occupancy)||0),0)/approaches.length:null;
    const phase=event?.phase_order?.[0]||approaches.slice().sort((a,b)=>(num(b.controller?.effective_priority)||0)-(num(a.controller?.effective_priority)||0))[0]?.label;
    text($('trafficActiveVehicles'),approaches.length?active:'—');text($('trafficQueue'),approaches.length?queue:'—');text($('trafficOccupancy'),occupancy==null?'—':`${(occupancy*100).toFixed(1)}%`);text($('trafficSignalPhase'),phase?String(phase).replaceAll('_',' '):'—');text($('trafficVideoTime'),`${current.toFixed(1)} s`);
  }
  function updateTrafficMetricsPlayback(){
    const video=$('trafficIntelligenceVideo2');if(!video)return;const current=video.currentTime||0,event=trafficEventAt(current,trafficEvents2),approaches=Array.isArray(event?.approaches)?event.approaches:[];
    const density=approaches.length?approaches.reduce((sum,a)=>sum+(num(a.occupancy)||0),0)/approaches.length:null;
    const volume=num(trafficSummary2.volume);
    text($('trafficDensity2'),density==null?'—':`${(density*100).toFixed(1)}%`);text($('trafficVolume2'),approaches.length?`${Math.round(volume)} veh/hr`:'—');text($('trafficVideoTime2'),`${current.toFixed(1)} s`);
  }
  async function loadTrafficIntelligence(){
    const video=$('trafficIntelligenceVideo'),status=$('trafficPipelineStatus'),fallback=$('trafficVideoFallback');if(!video)return;
    const setState=(label,kind='clear')=>{text(status,label);if(status)status.className=`badge ${kind}`;};
    try{
      const [metricsResponse,eventsResponse,summary2Response,events2Response]=await Promise.all([fetch('assets/traffic-intelligence/traffic_metrics.json',{cache:'no-store'}),fetch('assets/traffic-intelligence/cam_1_events.json',{cache:'no-store'}),fetch('assets/traffic-intelligence/traffic_9_summary.json',{cache:'no-store'}),fetch('assets/traffic-intelligence/traffic_9_events.json',{cache:'no-store'})]);
      if(!metricsResponse.ok||!eventsResponse.ok||!summary2Response.ok||!events2Response.ok)throw new Error('Traffic intelligence assets were not found');
      const metrics=await metricsResponse.json(),events=await eventsResponse.json(),summary2=await summary2Response.json(),events2=await events2Response.json(),camera=metrics.cam_1||metrics.traffic_1||{};
      trafficEvents=(Array.isArray(events)?events:[]).sort((a,b)=>(num(a.video_time_s)||0)-(num(b.video_time_s)||0));
      text($('trafficTrackedVehicles'),num(camera.perception?.vehicles)??'—');text($('trafficCars'),num(camera.perception?.cars)??'—');text($('trafficMotorcycles'),num(camera.perception?.motorcycles)??'—');
      trafficSummary2=summary2;trafficEvents2=(Array.isArray(events2)?events2:[]).sort((a,b)=>(num(a.video_time_s)||0)-(num(b.video_time_s)||0));text($('trafficCars2'),num(summary2.perception?.cars)??'—');text($('trafficBuses2'),num(summary2.perception?.buses)??'—');text($('trafficVolume2'),num(summary2.volume)==null?'—':`${Math.round(num(summary2.volume))} veh/hr`);renderVehicleDistribution(summary2.perception);
      video.src='assets/traffic-intelligence/cam_1_annotated.mp4?v=20260909';
      video.addEventListener('loadeddata',()=>{if(fallback)fallback.hidden=true;setState('RUNNING');video.play().catch(()=>setState('PRESS PLAY','warning'));},{once:true});
      video.addEventListener('play',()=>setState('RUNNING'));video.addEventListener('pause',()=>setState(video.ended?'ENDED':'PAUSED','warning'));video.addEventListener('timeupdate',updateTrafficModelMetrics);video.addEventListener('seeked',updateTrafficModelMetrics);
      video.addEventListener('error',()=>{if(fallback){fallback.hidden=false;fallback.textContent='Annotated traffic video could not be loaded.';}setState('VIDEO ERROR','danger');});
      updateTrafficModelMetrics();video.load();
      const video2=$('trafficIntelligenceVideo2'),status2=$('trafficPipelineStatus2'),fallback2=$('trafficVideoFallback2');
      if(video2){const state2=(label,kind='clear')=>{text(status2,label);if(status2)status2.className=`badge ${kind}`;};video2.src='assets/traffic-intelligence/traffic_9_annotated.mp4?v=20260909';video2.addEventListener('loadeddata',()=>{if(fallback2)fallback2.hidden=true;state2('RUNNING');video2.play().catch(()=>state2('PRESS PLAY','warning'));},{once:true});video2.addEventListener('play',()=>state2('RUNNING'));video2.addEventListener('pause',()=>state2(video2.ended?'ENDED':'PAUSED','warning'));video2.addEventListener('timeupdate',updateTrafficMetricsPlayback);video2.addEventListener('seeked',updateTrafficMetricsPlayback);video2.addEventListener('error',()=>{if(fallback2){fallback2.hidden=false;fallback2.textContent='Traffic metrics video could not be loaded.';}state2('VIDEO ERROR','danger');});updateTrafficMetricsPlayback();video2.load();}
    }catch(err){if(fallback){fallback.hidden=false;fallback.textContent=err.message;}setState('UNAVAILABLE','danger');}
  }

  const announcedCriticalAlertIds=new Set();let audioContext=null,soundEnabled=false,currentAccident=null,alertPollBusy=false;
  function alertTypeLabel(a){return pick(a,['alert_type','type'],'ALERT');}function alertStatus(a){return String(pick(a,['status'],'ACTIVE')).toUpperCase();}function alertSeverity(a){return String(pick(a,['severity'],'HIGH')).toUpperCase();}
  function isCriticalAccident(a){return String(alertTypeLabel(a)).toUpperCase()==='ACCIDENT'&&alertSeverity(a)==='CRITICAL'&&alertStatus(a)!=='CLEARED';}
  function playCriticalTone(){if(!soundEnabled||!audioContext||audioContext.state!=='running')return;const start=audioContext.currentTime;[740,520,740].forEach((frequency,index)=>{const oscillator=audioContext.createOscillator(),gain=audioContext.createGain(),at=start+index*.2;oscillator.frequency.value=frequency;gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.14,at+.025);gain.gain.exponentialRampToValueAtTime(.0001,at+.17);oscillator.connect(gain).connect(audioContext.destination);oscillator.start(at);oscillator.stop(at+.18);});}
  function accidentMetadata(a){return a?.metadata&&typeof a.metadata==='object'?a.metadata:{};}
  function seekPanelVideo(seconds){const video=$('accidentPanelVideo'),target=Math.max(0,(num(seconds)||0)-2),seek=()=>{try{video.currentTime=Math.min(target,Number.isFinite(video.duration)?video.duration:target);video.pause();}catch{}};if(video.readyState>=1)seek();else video.addEventListener('loadedmetadata',seek,{once:true});}
  function updateAccidentPanel(a){const panel=$('accidentEvidencePanel'),status=$('accidentPanelStatus');if(!a){panel?.classList.remove('critical');text(status,'MONITORING');if(status)status.className='badge clear';text($('accidentPanelState'),'MONITORING');text($('accidentPanelScore'),'—');text($('accidentPanelConfidence'),'—');text($('accidentPanelCamera'),'—');text($('accidentPanelTime'),'—');text($('accidentPanelMessage'),'Awaiting accident detection event');if($('accidentScoreFill'))$('accidentScoreFill').style.width='0%';return;}const m=accidentMetadata(a),score=num(m.fused_score),confidence=num(m.accident_model_confidence),when=num(m.video_time_s),critical=score!=null&&score>75;currentAccident=a;panel?.classList.toggle('critical',critical);text(status,critical?'CRITICAL':'MONITORING');if(status)status.className=`badge ${critical?'danger':'clear'}`;text($('accidentPanelState'),String(m.accident_state||'—').replaceAll('_',' '));text($('accidentPanelScore'),score==null?'—':`${score.toFixed(1)} / 100`);text($('accidentPanelConfidence'),confidence==null?'—':`${(confidence*100).toFixed(1)}%`);text($('accidentPanelCamera'),a.camera_id||'—');text($('accidentPanelTime'),when==null?fmtTime(a.started_at):`${when.toFixed(2)} s`);text($('accidentPanelMessage'),critical?'Critical threshold exceeded · system alert active':'Accident evidence received');if($('accidentScoreFill'))$('accidentScoreFill').style.width=`${Math.max(0,Math.min(100,score||0))}%`;}
  function showAccidentBanner(a){const m=accidentMetadata(a),score=num(m.fused_score),confidence=num(m.accident_model_confidence),when=num(m.video_time_s);currentAccident=a;updateAccidentPanel(a);seekPanelVideo(when);text($('criticalAccidentDetails'),`${pick(a,['camera_id'],'—')} · Fused ${score==null?'—':score.toFixed(1)}/100 · Model ${confidence==null?'—':(confidence*100).toFixed(1)+'%'} · ${when==null?fmtTime(a.started_at):when.toFixed(2)+'s'}`);if($('criticalAccidentBanner'))$('criticalAccidentBanner').hidden=false;}
  function processCriticalAccidents(alerts){const critical=alerts.filter(isCriticalAccident),badge=$('criticalAlertBadge');if(badge){badge.textContent=critical.length;badge.hidden=!critical.length;}if(critical.length)updateAccidentPanel(critical[critical.length-1]);else updateAccidentPanel(null);for(const alert of critical){const id=String(alert.alert_id);if(!announcedCriticalAlertIds.has(id)){announcedCriticalAlertIds.add(id);showAccidentBanner(alert);playCriticalTone();}}}
  function openAccidentEvidence(a=currentAccident){if(a){currentAccident=a;updateAccidentPanel(a);}if(typeof showPage==='function')showPage('alerts');const panel=$('accidentEvidencePanel');panel?.scrollIntoView({behavior:'smooth',block:'start'});if(a)seekPanelVideo(accidentMetadata(a).video_time_s);}
  window.ETRIS_openAccidentEvidence=openAccidentEvidence;
  function decorateAccidentCards(alerts){const cards=[...document.querySelectorAll('#alertsGrid .alert-card')];alerts.forEach((a,index)=>{if(!isCriticalAccident(a)||!cards[index])return;const m=accidentMetadata(a),score=num(m.fused_score),confidence=num(m.accident_model_confidence),details=cards[index].querySelector('.alert-details');details.innerHTML=`<p><span>Camera/source</span>${esc(a.camera_id||'—')}</p><p><span>Fused Score</span>${score==null?'—':esc(score.toFixed(1)+' / 100')}</p><p><span>Accident Model Confidence</span>${confidence==null?'—':esc((confidence*100).toFixed(1)+'%')}</p><p><span>State</span>${esc(m.accident_state||'—')}</p><p><span>Video time</span>${num(m.video_time_s)==null?'—':esc(num(m.video_time_s).toFixed(2)+' s')}</p><div class="alert-actions"><button type="button" class="secondary-btn">VIEW EVIDENCE</button></div>`;details.querySelector('button').addEventListener('click',()=>openAccidentEvidence(a));});}
  async function pollAlerts(){if(alertPollBusy)return;alertPollBusy=true;try{await loadAlerts();const all=asArray(await api.alerts.list()),active=asArray(await api.alerts.active());processCriticalAccidents(active);decorateAccidentCards(all);renderParkingSummary(all);decorateParkingCards(all);}catch{}finally{alertPollBusy=false;}}
  function parkingOccupancy(a){const value=num(a?.occupancy_percent,a?.metadata?.occupancy_percent,a?.restricted_overlap,a?.metadata?.restricted_overlap);return value==null?null:(value<=1?value*100:value);}
  function parkingDuration(a){return num(a?.stationary_duration_s,a?.metadata?.stationary_seconds);}
  function parkingEvidenceMarkup(a){const occupancy=parkingOccupancy(a),duration=parkingDuration(a),zone=pick(a?.metadata,['zone_label'],pick(a,['zone_id'],'—')),state=pick(a,['parking_state'],alertStatus(a)),videoTime=num(a?.metadata?.video_time_s,a?.confirmed_at);return `<p><span>Vehicle ID</span>#${esc(pick(a,['track_id'],'—'))}</p><p><span>Vehicle Type</span>${esc(pick(a,['vehicle_class'],'—'))}</p><p><span>Restricted Zone</span>${esc(zone)}</p><p><span>Violation Duration</span>${duration==null?'—':esc(duration.toFixed(1)+' s')}</p><p><span>Restricted-Zone Occupancy</span>${occupancy==null?'—':esc(occupancy.toFixed(1)+'%')}</p><p><span>State</span>${esc(state)}</p><p><span>Camera</span>${esc(pick(a,['camera_id'],'—'))}</p><p><span>Video Time</span>${videoTime==null?'—':esc(videoTime.toFixed(2)+' s')}</p><div class="alert-actions"><button type="button" class="secondary-btn parking-evidence-button">VIEW EVIDENCE</button></div>`;}
  function renderParkingSummary(alerts){const rows=alerts.filter(a=>String(alertTypeLabel(a)).toUpperCase()==='RESTRICTED_PARKING'),active=rows.filter(a=>alertStatus(a)!=='CLEARED'),latest=rows[rows.length-1],durations=rows.map(parkingDuration).filter(v=>v!=null),occupancy=latest?parkingOccupancy(latest):null;text($('parkingViolationCount'),rows.length);text($('parkingActiveCount'),active.length);text($('parkingLatestVehicle'),latest?`#${pick(latest,['track_id'],'—')}`:'—');text($('parkingLongestDuration'),durations.length?`${Math.max(...durations).toFixed(1)} s`:'—');text($('parkingOccupancyValue'),occupancy==null?'—':`${occupancy.toFixed(1)}%`);if($('parkingOccupancyFill'))$('parkingOccupancyFill').style.width=`${Math.max(0,Math.min(100,occupancy||0))}%`;}
  function openParkingEvidence(a){const modal=$('accidentEvidenceModal'),video=$('accidentEvidenceVideo'),details=$('accidentEvidenceDetails'),title=$('accidentEvidenceTitle'),when=num(a?.metadata?.video_time_s,a?.confirmed_at);text(title,'Restricted Parking Evidence');video.src=api.alerts.restrictedParkingEvidenceUrl()+'?v=20260909';details.innerHTML=parkingEvidenceMarkup(a).replace(/<div class="alert-actions">[\s\S]*?<\/div>$/,'');modal.classList.add('open');const seek=()=>{video.currentTime=Math.max(0,(when||0)-2);video.pause();};if(video.readyState>=1)seek();else video.addEventListener('loadedmetadata',seek,{once:true});}
  function decorateParkingCards(alerts){const cards=[...document.querySelectorAll('#alertsGrid .alert-card')];alerts.forEach((a,index)=>{if(String(alertTypeLabel(a)).toUpperCase()!=='RESTRICTED_PARKING'||!cards[index])return;const card=cards[index],details=card.querySelector('.alert-details'),heading=card.querySelector('h2'),badge=card.querySelector('.badge');card.dataset.type=alertStatus(a)==='CLEARED'?'resolved':'warning';if(heading)heading.textContent='RESTRICTED PARKING DETECTED';if(badge){badge.className=`badge ${alertStatus(a)==='CLEARED'?'clear':'warning'}`;badge.textContent=alertStatus(a);}details.innerHTML=parkingEvidenceMarkup(a);details.querySelector('.parking-evidence-button')?.addEventListener('click',()=>openParkingEvidence(a));});}
  async function loadAlerts(){
    const grid=$('alertsGrid');try{const[allRaw,activeRaw]=await Promise.all([api.alerts.list(),api.alerts.active().catch(()=>[])]);const alerts=asArray(allRaw),active=asArray(activeRaw);text($('overviewAlerts'),active.length);text($('overviewAlertsNote'),`${alerts.length} total alert records`);renderOverviewAlerts(active.slice(0,3));if(!grid)return;if(!alerts.length){grid.innerHTML='<p class="empty-state">No alerts returned by backend.</p>';return;}grid.innerHTML=alerts.map(a=>{const sev=alertSeverity(a),status=alertStatus(a),type=alertTypeLabel(a),critical=status!=='CLEARED'&&/critical|high/.test(sev.toLowerCase()),time=pick(a,['detected_at','confirmed_time','entry_time','started_at','created_at','last_updated_at'],'—'),camera=pick(a,['camera_id'],'—'),zone=pick(a,['zone_label','zone_id'],'—'),track=pick(a,['track_id'],'—'),vehicle=pick(a,['vehicle_class'],'—'),blacklist=String(type).toUpperCase()==='BLACKLISTED_VEHICLE',restrictedZone=String(type).toUpperCase()==='RESTRICTED_ZONE',congestionAlert=['CONGESTION','SEVERE_DELAY'].includes(String(type).toUpperCase()),plate=pick(a,['plate_text','plate'],'—'),reason=pick(a,['watchlist_reason'],'—'),confidence=num(pick(a,['plate_confidence','confidence'])),demo=Boolean(pick(a,['demo_watchlist_entry'],false)),inside=num(pick(a,['inside_duration_s'])),authorization=pick(a,['authorization_reason'],'—'),segId=pick(a,['segment_id','zone_id'],'—'),congState=pick(a,['congestion_state'],'—'),delayRatio=num(pick(a,['delay_ratio'])),obsTime=num(pick(a,['observed_travel_time_s'])),basTime=num(pick(a,['baseline_travel_time_s'])),sampleCount=pick(a,['sample_count'],'—'),confirmedAt=pick(a,['confirmed_at'],'—');const evidence=blacklist?`<p><span>Plate</span>${esc(plate)}</p><p><span>Reason</span>${esc(reason)}</p><p><span>Severity</span>${esc(sev)}</p><p><span>Camera</span>${esc(camera)}</p><p><span>Track</span>${esc(track)}</p><p><span>Vehicle</span>${esc(vehicle)}</p><p><span>ANPR Confidence</span>${confidence==null?'—':esc((confidence*100).toFixed(1)+'%')}</p><p><span>Timestamp</span>${esc(time)}</p>${demo?'<p><span>Source</span>DEMO WATCHLIST ENTRY</p>':''}`:restrictedZone?`<p><span>Zone</span>${esc(zone)}</p><p><span>Vehicle</span>${esc(vehicle)}</p><p><span>Track</span>${esc(track)}</p><p><span>Accepted Plate</span>${esc(plate)}</p><p><span>Camera</span>${esc(camera)}</p><p><span>Entry Time</span>${esc(pick(a,['entry_time'],'—'))}</p><p><span>Inside Duration</span>${inside==null?'—':esc(inside.toFixed(1)+' s')}</p><p><span>Authorization</span>${esc(authorization)}</p>`:congestionAlert?`<p><span>Segment</span>${esc(segId)}</p><p><span>State</span>${esc(congState)}</p><p><span>Delay Ratio</span>${delayRatio==null?'—':esc(delayRatio.toFixed(2)+'×')}</p><p><span>Observed Travel</span>${obsTime==null?'—':esc(obsTime.toFixed(1)+' s')}</p><p><span>Baseline Travel</span>${basTime==null?'—':esc(basTime.toFixed(1)+' s')}</p><p><span>Samples</span>${esc(String(sampleCount))}</p><p><span>Confirmed At</span>${esc(String(confirmedAt))}</p><p><span>Status</span>${esc(status)}</p>`:`<p><span>Vehicle</span>${esc(vehicle)}</p><p><span>Track</span>${esc(track)}</p><p><span>Zone</span>${esc(zone)}</p>`;return `<article class="panel alert-card" data-type="${status==='CLEARED'?'resolved':critical?'critical':'warning'}"><div class="alert-card-head"><span class="big-alert ${critical?'critical':'warning'}">${critical?'!':'•'}</span><div><small>${esc(time)} · ${esc(camera)}</small><h2>${esc(type.replaceAll('_',' '))}</h2></div><span class="badge ${status==='CLEARED'?'clear':critical?'danger':'warning'}">${esc(status)}</span></div><div class="alert-details">${evidence}</div></article>`;}).join('');if(typeof applyAlertFilter==='function')applyAlertFilter();}catch(err){if(grid)grid.innerHTML=`<p class="empty-state">Alert backend unavailable: ${esc(err.message)}</p>`;text($('overviewAlerts'),'—');text($('overviewAlertsNote'),'Alert API unavailable');renderOverviewAlerts([]);}}
  function renderOverviewAlerts(items){const host=$('overviewAlertList');if(!host)return;if(!items.length){host.innerHTML='<p class="empty-state">No active alerts returned.</p>';return;}host.innerHTML=items.map(a=>`<div class="mini-alert warning"><span class="alert-icon">!</span><div><b>${esc(alertTypeLabel(a).replaceAll('_',' '))}</b><small>${esc(pick(a,['camera_id'],'—'))} · ${esc(pick(a,['status'],'ACTIVE'))}</small></div></div>`).join('');}

  async function loadSignal(){const host=$('signalApproaches');try{const raw=await api.signal.demo(),plan=raw?.plan||raw?.baseline||raw,approaches=asArray(plan?.approaches||plan?.recommendations||plan?.phases||raw?.approaches||raw?.recommendations),cycle=num(plan?.cycle_duration_s,plan?.cycle_s,plan?.cycle_duration,raw?.cycle_duration_s);text($('signalCycle'),cycle!=null?`${cycle}s`:'—');text($('signalState'),'Online');text($('signalStateNote'),'Recommendation loaded');let priority='—';if(approaches.length){const sorted=[...approaches].sort((a,b)=>(num(b.priority,b.pressure,b.pressure_score)||0)-(num(a.priority,a.pressure,a.pressure_score)||0));priority=pick(sorted[0],['approach_id','id','name','label'],'—');}text($('signalPriority'),priority);if(!host)return;if(!approaches.length){host.innerHTML=`<pre class="api-json">${esc(JSON.stringify(raw,null,2))}</pre>`;return;}host.innerHTML=approaches.map(a=>{const id=pick(a,['approach_id','id','name','label'],'Approach'),pressure=num(a.pressure,a.pressure_score,a.priority),green=num(a.green_s,a.green_seconds,a.recommended_green_s,a.green_duration_s,a.green_duration),reason=pick(a,['reason','reason_code','reason_codes'],'Traffic demand');return `<div class="signal-row"><div><b>${esc(id)}</b><small>${esc(Array.isArray(reason)?reason.join(' · '):reason)}</small></div><div><span>Pressure</span><strong>${pressure!=null?pressure.toFixed(3):'—'}</strong></div><div><span>Green</span><strong>${green!=null?green+'s':'—'}</strong></div></div>`;}).join('');}catch(err){text($('signalState'),'Offline');text($('signalStateNote'),err.message);if(host)host.innerHTML=`<p class="empty-state">Signal-control API unavailable: ${esc(err.message)}</p>`;}}

  function extractSightings(raw){const rows=asArray(raw);if(rows.length)return rows;if(raw&&typeof raw==='object'){const nested=pick(raw,['sightings','events','observations','points']);if(Array.isArray(nested))return nested;}return [];}
  function extractTrajectory(raw){const rows=asArray(raw);if(rows.length)return rows;if(raw&&typeof raw==='object'){for(const key of ['sightings','trajectory','points','segments','events'])if(Array.isArray(raw[key]))return raw[key];}return [];}
  function sightingTime(s){return pick(s,['timestamp','observed_at','captured_at','time','source_time','ts'],'—');}
  function sightingCamera(s){return pick(s,['camera_id','camera','source_camera','id'],'—');}

  async function searchVehicle(){
    const input=$('vehicleSearch');const rawPlate=input?.value.trim()||'';if(!rawPlate){openModal('Enter a registration','Enter a vehicle registration number to query the sightings and trajectory APIs.');return;}
    const plate=normalizePlate(rawPlate);text($('trackingPlate'),plate);text($('trackingStatus'),'Searching…');
    try{
      const[sRaw,tRaw]=await Promise.all([api.tracking.byPlate(plate),api.tracking.trajectory(plate).catch(()=>({}))]);
      let sightings=extractSightings(sRaw);let trajectory=extractTrajectory(tRaw);if(!sightings.length&&trajectory.length)sightings=trajectory;
      sightings=[...sightings].sort((a,b)=>new Date(sightingTime(a))-new Date(sightingTime(b)));
      renderTracking(plate,sightings,tRaw,trajectory);
      if(!sightings.length)openModal('No sightings',`The backend returned no sightings for ${plate}.`);
    }catch(err){renderTracking(plate,[],{},[]);text($('trackingStatus'),'Unavailable');openModal('Vehicle lookup failed',err.message);}
  }
  window.ETRIS_searchVehicle=searchVehicle;

  function renderTracking(plate,sightings,tRaw,trajectory){
    text($('trackingPlate'),plate);const first=sightings[0],last=sightings[sightings.length-1];const vehicle=pick(last||first,['vehicle_class','vehicle_type','class_name','class'],'—');
    text($('trackingVehicleType'),vehicle);text($('trackingVehicleSymbol'),vehicle==='—'?'VEHICLE':String(vehicle).toUpperCase());text($('trackingFirst'),first?fmtTime(sightingTime(first)):'—');text($('trackingLast'),last?fmtTime(sightingTime(last)):'—');
    text($('trackingSightingsCount'),sightings.length);text($('trackingTotalSightings'),sightings.length);const cams=new Set(sightings.map(sightingCamera).filter(v=>v&&v!=='—'));text($('trackingCameraCount'),`${cams.size} camera${cams.size===1?'':'s'}`);text($('trackingStatus'),sightings.length?'Found':'No sightings');
    const distance=num(tRaw?.total_distance_km,tRaw?.distance_km,tRaw?.total_distance_m,tRaw?.distance_m);let distanceLabel='—';if(distance!=null){const isM=tRaw?.total_distance_m!=null||tRaw?.distance_m!=null;distanceLabel=isM?`${(distance/1000).toFixed(2)} km`:`${distance.toFixed(2)} km`;}text($('trackingDistance'),distanceLabel);
    const speed=num(tRaw?.average_speed_kmh,tRaw?.avg_speed_kmh,tRaw?.speed_kmh);text($('trackingSpeed'),speed==null?'—':`${speed.toFixed(1)} km/h`);
    let duration=num(tRaw?.duration_s,tRaw?.travel_time_s,tRaw?.total_time_s);if(duration==null&&first&&last){const a=new Date(sightingTime(first)),b=new Date(sightingTime(last));if(!Number.isNaN(a.getTime())&&!Number.isNaN(b.getTime()))duration=(b-a)/1000;}text($('trackingDuration'),duration==null?'—':duration<60?`${Math.round(duration)}s`:`${Math.round(duration/60)}m`);
    renderTrackingTimeline(sightings);renderTrackingRoute(trajectory.length?trajectory:sightings);
  }
  function renderTrackingTimeline(sightings){const host=$('trackingTimeline');if(!host)return;if(!sightings.length){host.innerHTML='<p class="empty-state">No sightings returned for this vehicle.</p>';return;}host.innerHTML=[...sightings].reverse().map((s,i)=>`<div class="timeline-item ${i===0?'last':''}"><i></i><div class="timeline-content"><div class="timeline-title"><b>${esc(sightingCamera(s))}</b><span class="timeline-time">${esc(fmtTime(sightingTime(s)))}</span>${i===0?'<em>Latest</em>':''}</div><span class="timeline-location">${esc(pick(s,['location','camera_name','zone','direction'],'Backend sighting'))}</span></div></div>`).join('');}
  function renderTrackingRoute(points){const locations=$('trackingRouteLocations'),svg=$('trackingRouteSvg'),empty=$('trackingRouteEmpty');if(!locations||!svg)return;locations.innerHTML='';svg.innerHTML='';if(empty)empty.hidden=points.length>0;if(!points.length)return;const count=points.length;const coords=points.map((p,i)=>{const x=count===1?50:14+(72*i/(count-1));const wave=[35,65,28,70,42,62];const y=wave[i%wave.length];return{x,y,p};});coords.forEach(({x,y,p},i)=>{if(i){const prev=coords[i-1];svg.insertAdjacentHTML('beforeend',`<line class="route-line route-line-cyan" x1="${prev.x}" y1="${prev.y}" x2="${x}" y2="${y}"/>`);}const node=document.createElement('div');node.className='route-location';node.style.left=`${x}%`;node.style.top=`${y}%`;node.style.transform='translate(-50%,-50%)';node.innerHTML=`<div class="location-label"><b>${esc(sightingCamera(p))}</b><span>${esc(fmtTime(sightingTime(p)))}</span></div><div class="location-dot ${i===count-1?'current':'detected'}"></div>`;locations.appendChild(node);});}

  const supportedVideoExtensions=new Set(['mp4','mov','avi','mkv']);
  const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  async function waitForVideoJob(jobId,state){
    for(;;){const job=await api.videos.job(jobId);state.textContent=job.status==='processing'?(job.progress==null?'Processing...':`Processing... ${Math.floor(job.progress)}% (${job.frames_processed}/${job.total_frames} frames)`):job.status;if(job.status==='completed')return job;if(job.status==='failed')throw new Error(job.error||'Video processing failed');await wait(1000);}
  }
  async function applyUploadedVideoResult(pipeline,job,filename){
    const cache=`?job=${encodeURIComponent(job.job_id)}`;
    if(pipeline==='anpr'){
      const stream=$('anprStream'),recorded=$('anprRecordedVideo');if(recorded)recorded.hidden=true;if(stream){stream.hidden=false;stream.src=api.anpr.streamUrl()+`?t=${Date.now()}`;}await loadAnpr();return;
    }
    if(pipeline==='traffic_analytics'){
      const [summary,events]=await Promise.all([api.videos.summary(job.job_id),api.videos.events(job.job_id)]);trafficSummary2=summary;trafficEvents2=(Array.isArray(events)?events:[]).sort((a,b)=>(num(a.video_time_s)||0)-(num(b.video_time_s)||0));text($('trafficCars2'),num(summary.perception?.cars)??'â€”');text($('trafficBuses2'),num(summary.perception?.buses)??'â€”');text($('trafficVolume2'),num(summary.volume)==null?'â€”':`${Math.round(num(summary.volume))} veh/hr`);renderVehicleDistribution(summary.perception);const video=$('trafficIntelligenceVideo2');if(video){video.src=api.videos.videoUrl(job.job_id)+cache;video.hidden=false;video.load();video.play().catch(()=>{});}updateTrafficMetricsPlayback();return;
    }
    const summary=await api.videos.summary(job.job_id),event=summary.strongest_event||{},score=num(event.score)||0,confidence=num(event.accident_model_confidence),confirmed=summary.final_classification==='ACCIDENT_CONFIRMED',panel=$('accidentEvidencePanel2'),status=$('accidentPanelStatus2');panel?.classList.toggle('critical',confirmed);text(status,String(summary.final_classification||'NO_ACCIDENT').replaceAll('_',' '));if(status)status.className=`badge ${confirmed?'danger':'clear'}`;text($('accidentPanelState2'),String(summary.final_classification||'NO_ACCIDENT').replaceAll('_',' '));text($('accidentPanelScore2'),`${score.toFixed(2)} / 100`);text($('accidentPanelConfidence2'),confidence==null?'â€”':`${(confidence*100).toFixed(2)}%`);text($('accidentPanelTime2'),event.video_time_s==null?'â€”':`${Number(event.video_time_s).toFixed(2)} s`);text($('accidentPanelMessage2'),confirmed?`Critical accident confirmed at frame ${event.frame_index}`:'No confirmed accident detected in this video');if($('accidentScoreFill2'))$('accidentScoreFill2').style.width=`${Math.max(0,Math.min(100,score))}%`;const heading=panel?.querySelector('.panel-head p');if(heading)heading.textContent=`${filename} · processed by YOLO11x with temporal and geometry fusion`;const video=$('accidentPanelVideo2');if(video){video.hidden=false;video.src=api.videos.videoUrl(job.job_id)+cache;video.load();video.play().catch(()=>{});}
  }
  function initializeVideoSelectors(){
    document.querySelectorAll('.video-source-selector').forEach(control=>{const input=control.querySelector('input[type=file]'),add=control.querySelector('.video-add-button'),run=control.querySelector('.video-run-button'),change=control.querySelector('.video-change-button'),selection=control.querySelector('.video-selection'),name=control.querySelector('.video-selected-name'),state=control.querySelector('.video-job-state'),pipeline=control.dataset.videoPipeline;let selected=null;const choose=()=>input.click();add.addEventListener('click',choose);change.addEventListener('click',choose);input.addEventListener('change',()=>{const file=input.files?.[0];if(!file)return;const extension=file.name.split('.').pop().toLowerCase();state.className='video-job-state';if(!supportedVideoExtensions.has(extension)){selected=null;selection.hidden=false;name.textContent=file.name;state.textContent='Unsupported format. Use MP4, MOV, AVI, or MKV.';state.classList.add('is-error');run.hidden=true;change.hidden=false;add.hidden=true;return;}selected=file;name.textContent=file.name;state.textContent='Ready';selection.hidden=false;run.hidden=false;change.hidden=false;add.hidden=true;});run.addEventListener('click',async()=>{if(!selected)return;run.disabled=change.disabled=true;state.className='video-job-state';try{state.textContent='Uploading...';const uploaded=await api.videos.upload(selected);state.textContent='Processing...';const started=await api.videos.run(uploaded.video_id,pipeline),completed=await waitForVideoJob(started.job_id,state);await applyUploadedVideoResult(pipeline,completed,selected.name);state.textContent='Completed';state.classList.add('is-success');}catch(error){state.textContent=error.message||'Processing failed';state.classList.add('is-error');}finally{run.disabled=change.disabled=false;}});});
  }

  document.addEventListener('DOMContentLoaded',async()=>{
    initializeVideoSelectors();
    const accidentVideo=$('accidentPanelVideo');if(accidentVideo){accidentVideo.src=api.alerts.accidentEvidenceUrl()+'?v=20260909-h264';accidentVideo.addEventListener('loadedmetadata',()=>{text($('accidentVideoStatus'),'Accident evidence ready');});accidentVideo.addEventListener('error',()=>{accidentVideo.hidden=true;text($('accidentVideoStatus'),'ACCIDENT EVIDENCE UNAVAILABLE');});}
    const accidentVideo2=$('accidentPanelVideo2');if(accidentVideo2){accidentVideo2.src='assets/accident-evidence/accident_2_annotated.mp4?v=20260909';accidentVideo2.addEventListener('loadeddata',()=>{text($('accidentVideoStatus2'),'Accident 2 evidence ready');$('accidentVideoStatus2').hidden=true;accidentVideo2.play().catch(()=>{text($('accidentVideoStatus2'),'Press play to view accident 2 evidence');$('accidentVideoStatus2').hidden=false;});},{once:true});accidentVideo2.addEventListener('error',()=>{accidentVideo2.hidden=true;text($('accidentVideoStatus2'),'ACCIDENT 2 EVIDENCE UNAVAILABLE');});}
    loadHealth();await loadCameras();loadAnalytics();loadTrafficIntelligence();pollAlerts();loadSignal();loadAnpr();
    setInterval(pollAlerts,1800);
    $('alertSoundToggle')?.addEventListener('click',async()=>{audioContext=audioContext||new (window.AudioContext||window.webkitAudioContext)();await audioContext.resume();soundEnabled=true;$('alertSoundToggle').textContent='🔊 ALERT SOUND: ENABLED';$('alertSoundToggle').classList.add('enabled');});
    $('bannerDismissButton')?.addEventListener('click',()=>{$('criticalAccidentBanner').hidden=true;});$('bannerEvidenceButton')?.addEventListener('click',()=>openAccidentEvidence());$('closeAccidentEvidence')?.addEventListener('click',()=>{const modal=$('accidentEvidenceModal'),video=$('accidentEvidenceVideo');video.pause();modal.classList.remove('open');});
    $('refreshSignalBtn')?.addEventListener('click',loadSignal);$('anprRefreshBtn')?.addEventListener('click',loadAnpr);$('cameraSelect')?.addEventListener('change',loadAnpr);
    $('anprPlayBtn')?.addEventListener('click',()=>anprAction('play'));$('anprPauseBtn')?.addEventListener('click',()=>anprAction('pause'));$('anprRestartBtn')?.addEventListener('click',()=>anprAction('restart'));
    $('anprRate')?.addEventListener('change',async e=>{try{await api.anpr.processingRate(e.target.value);await loadAnpr();}catch(err){openModal('Processing rate failed',err.message);}});
    $('anprStream')?.addEventListener('error',()=>{const stream=$('anprStream'),fallback=$('anprMediaFallback');if(fallback){fallback.hidden=false;fallback.textContent='Live stream reconnecting…';}setTimeout(()=>{if(stream){stream.hidden=false;stream.src=api.anpr.streamUrl()+`?t=${Date.now()}`;}},1800);});
    const anubhavStream=$('anubhavStream');if(anubhavStream&&api.anubhavAnpr){anubhavStream.src=api.anubhavAnpr.streamUrl()+`?t=${Date.now()}`;anubhavStream.addEventListener('error',()=>{const fallback=$('anubhavMediaFallback');if(fallback){fallback.hidden=false;fallback.textContent='Stream reconnecting…';}setTimeout(()=>{anubhavStream.src=api.anubhavAnpr.streamUrl()+`?t=${Date.now()}`;},1800);});}
    $('anubhavPlayBtn')?.addEventListener('click',()=>anubhavAction('play'));$('anubhavPauseBtn')?.addEventListener('click',()=>anubhavAction('pause'));$('anubhavRestartBtn')?.addEventListener('click',()=>anubhavAction('restart'));loadAnubhavAnpr();
    setInterval(loadHealth,15000);setInterval(loadAnpr,4000);setInterval(loadAnubhavAnpr,4000);
  });
})();
