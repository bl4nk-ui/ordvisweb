import {randomUUID} from 'node:crypto';
import {summarizeLead} from './ai-summary.mjs';
const HOUR=3600000;
const MESSAGES={NOT_CONFIGURED:'Groq anahtarı sunucuda kurulmalı.',AUTH:'Groq anahtarı doğrulanamadı. Sunucudaki anahtarı kontrol edin.',RATE_LIMIT:'Groq kotası veya istek sınırı doldu. Belirlenen sürede yeniden denenecek.',PROVIDER_UNAVAILABLE:'Groq’a şu anda ulaşılamıyor. Daha sonra yeniden denenecek.',INVALID_OUTPUT:'Bu talep için geçerli bir özet alınamadı. Yeni deneme planlandı.',INVALID_INPUT:'Talep bilgileri özetlemeye uygun değil.',BUDGET:'Saatlik beş deneme sınırına ulaşıldı. Sonraki zaman aralığı bekleniyor.'};
const iso=value=>Number.isFinite(value)&&value>0?new Date(value).toISOString():null;
export function createAutomation({store,getConfig,summarize=summarizeLead,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 const owner=randomUUID();let timer=null,closed=false,running=null,controller=null;
 function config(){let value;try{value=getConfig?.()||{};}catch{return {apiKey:null,model:'llama-3.3-70b-versatile'};}return {apiKey:typeof value.apiKey==='string'&&value.apiKey.trim()?value.apiKey:null,model:typeof value.model==='string'&&/^[a-zA-Z0-9._/-]{1,100}$/.test(value.model)?value.model:'llama-3.3-70b-versatile'};}
 function status(){const state=store.getAutomationSettings(),settings=config();return {enabled:state.enabled,configured:Boolean(settings.apiKey),provider:'groq',model:settings.model,intervalMinutes:60,nextRunAt:iso(state.nextRunAt),lastRunAt:iso(state.lastRunAt),lastError:MESSAGES[state.lastError]||null,pendingCount:store.aiPendingCount(),failedCount:store.aiFailedCount?.()||0,summaries:store.listAiSummaries(),status:!state.enabled?'disabled':!settings.apiKey?'needs_key':running?'running':state.retryAt?'waiting_retry':state.lastError?'error':'scheduled',retryAt:iso(state.retryAt)};}
 function arm(){if(timer!==null){clearTimer(timer);timer=null;}if(closed||running)return;const state=store.getAutomationSettings();if(!state.enabled)return;const current=now(),target=Math.max(state.retryAt??state.nextRunAt??current+HOUR,state.leaseUntil||0);timer=setTimer(()=>{timer=null;void tick();},Math.max(1000,Math.min(HOUR,target-current)));timer?.unref?.();}
 function setEnabled(enabled){if(typeof enabled!=='boolean')throw new TypeError('Etkinlik ayarı geçersiz.');const state=store.getAutomationSettings();if(state.enabled!==enabled){controller?.abort();store.updateAutomationSettings({enabled,generation:state.generation+1,nextRunAt:enabled?now()+HOUR:null,retryAt:null,lastError:null});if(!enabled)store.releaseAiLease(owner);arm();}return status();}
 async function run(){
  const initial=store.getAutomationSettings(),time=now();if(closed||!initial.enabled||time<(initial.retryAt??initial.nextRunAt??Infinity))return;
  if(!store.claimAiLease(owner,time))return;
  const generation=initial.generation;controller=new AbortController();
  const current=()=>!closed&&store.getAutomationSettings().enabled&&store.getAutomationSettings().generation===generation;
  try{
   const settings=config();if(!settings.apiKey){store.updateAutomationSettings({lastError:'NOT_CONFIGURED',nextRunAt:time+HOUR,retryAt:null});return;}
   const candidates=store.pendingAiLeads(5);
   for(const lead of candidates){
    if(!current())return;
    if(!store.isAiLeadEligible(lead.id))continue;
    const until=store.reserveAiAttempt(now(),5);if(until){store.updateAutomationSettings({lastError:'BUDGET',retryAt:until});return;}
    store.updateAutomationSettings({lastRunAt:now()});
    try{
     const result=await summarize({name:lead.name,brief:lead.brief},{...settings,signal:controller.signal});
     if(!current())return;
     if(store.recordAiSuccess(lead,result,now()))store.audit('ai_summary_created');
    }catch(error){
     if(!current())return;
     if(!store.isAiLeadEligible(lead.id))continue;
     const code=Object.hasOwn(MESSAGES,error?.code)?error.code:'PROVIDER_UNAVAILABLE';store.recordAiFailure(lead,code,now());
     const retryable=['RATE_LIMIT','PROVIDER_UNAVAILABLE','INVALID_OUTPUT'].includes(code);
     const delay=Math.max(60000,Math.min(HOUR,(Number(error?.retryAfterSeconds)||60)*1000));
     store.updateAutomationSettings({lastError:code,nextRunAt:now()+HOUR,retryAt:retryable?now()+delay:null});store.audit('ai_summary_failed');return;
    }
   }
   if(current())store.updateAutomationSettings({lastError:null,retryAt:null,nextRunAt:now()+HOUR});
  }finally{controller=null;if(!closed)store.releaseAiLease(owner);}
 }
 function tick(){if(closed)return Promise.resolve();if(running)return running;running=run().catch(()=>{if(!closed)store.updateAutomationSettings({lastError:'PROVIDER_UNAVAILABLE',nextRunAt:now()+HOUR,retryAt:null});}).finally(()=>{running=null;arm();});return running;}
 function close(){if(closed)return;closed=true;if(timer!==null)clearTimer(timer);timer=null;controller?.abort();store.releaseAiLease(owner);}
 const initial=store.getAutomationSettings();if(initial.enabled&&!initial.nextRunAt&&!initial.retryAt)store.updateAutomationSettings({nextRunAt:now()+HOUR});arm();
 return {status,setEnabled,tick,close};
}
