(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const hash=location.hash.slice(1);
  const previewId=/^preview=([a-f0-9-]{36})$/i.exec(hash)?.[1]||null;
  let token=/^[a-f0-9]{64}$/.test(hash)?hash:'';
  if(token)history.replaceState(null,'',location.pathname+location.search);
  let delivery=null,busy=false,generation=0,drafts=[],editing=null,pendingRevision=null,reviewSubmitted=false;
  const players=new Map();
  const statuses={pending:'İncelemeni bekliyor',revision_requested:'Revizyon talebi iletildi',approved:'Bu sürüm onaylandı'};
  const stages={inquiry:'Talep alındı',proposal:'Teklif aşamasında',waiting:'Geri dönüş bekleniyor',scheduled:'Planlandı',production:'Üretimde',review:'İncelemede',delivered:'Teslim edildi'};
  const date=value=>{const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'—':new Intl.DateTimeFormat('tr-TR',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Istanbul'}).format(parsed)+' (TSİ)';};
  const money=cents=>new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY',maximumFractionDigits:0}).format((Number(cents)||0)/100);
  const size=bytes=>bytes<1024*1024?`${Math.max(1,Math.ceil(bytes/1024))} KB`:`${(bytes/(1024*1024)).toLocaleString('tr-TR',{maximumFractionDigits:1})} MB`;
  const timestamp=value=>{const seconds=Math.max(0,Math.floor(value||0));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;};
  const node=(tag,className,value)=>{const el=document.createElement(tag);if(className)el.className=className;if(value!==undefined)el.textContent=value;return el;};
  function message(value,error=false){$('delivery-message').textContent=value;$('delivery-message').classList.toggle('is-error',error);}
  function editable(){return !busy&&!previewId&&delivery?.status==='pending'&&!pendingRevision;}
  function updateActions(){
    const approved=delivery?.status==='approved',waiting=delivery?.status==='revision_requested',canEdit=editable();
    $('revision-form').hidden=Boolean(previewId)||approved||waiting;
    $('revision-waiting').hidden=Boolean(previewId)||!waiting;
    $('revision-message').disabled=!canEdit;$('fee-confirmation').disabled=!canEdit;
    $('revision-submit').disabled=busy||Boolean(previewId)||approved||waiting;
    $('revision-submit').textContent=pendingRevision?'Aynı turu tekrar gönder ↗':`Revizyon turunu gönder${Number(delivery?.revisions?.nextFeeCents)>0?' · '+money(delivery.revisions.nextFeeCents):''} ↗`;
    $('approve-open').disabled=busy||Boolean(previewId)||approved||waiting||Boolean(pendingRevision)||!delivery?.files?.length;
    $('approve-open').textContent=approved?'Bu sürüm onaylandı ✓':'Bu sürümü onayla ✓';
    $('approval-description').textContent=previewId?'Bu, müşterinin göreceği salt okunur önizlemedir.':approved?'Onayın stüdyoya ulaştı. Yeni bir sürüm geldiğinde yeniden inceleyebilirsin.':waiting?'Stüdyo revizyon talebini tamamlayıp yeni sürümü yüklediğinde onaylayabilirsin.':!delivery?.files?.length?'Stüdyo dosyaları eklediğinde bu sürümü onaylayabilirsin.':'Her şey hazırsa bu sürümü onaylayabilirsin.';
    $('delivery-refresh').disabled=busy;$('approve-submit').disabled=busy||Boolean(previewId);
    $('note-save').disabled=!canEdit;$('note-cancel').disabled=busy;
    for(const button of document.querySelectorAll('[data-edit-note],[data-remove-note],[data-add-note]'))button.disabled=!canEdit;
    $('testimonial-section').hidden=Boolean(previewId)||!approved;
    $('review-submit').disabled=busy||reviewSubmitted;
    for(const field of $('testimonial-form').querySelectorAll('input,textarea,select'))field.disabled=busy||reviewSubmitted;
  }
  function setBusy(value){busy=value;$('lookup-submit').disabled=value;$('state-retry').disabled=value;updateActions();}
  async function api(path,body,{authenticated=true}={}){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000),headers:{Accept:'application/json',...(authenticated&&token?{Authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error||'İşlem tamamlanamadı. Lütfen tekrar dene.');error.status=response.status;throw error;}return data;
  }
  function clearMedia(){for(const player of players.values()){player.pause();player.removeAttribute('src');player.load();}players.clear();$('delivery-files').replaceChildren();}
  function showLookup(description){
    generation++;delivery=null;token='';drafts=[];pendingRevision=null;editing=null;reviewSubmitted=false;clearMedia();closeEditor();$('revision-message').value='';$('fee-confirmation').checked=false;$('testimonial-form').reset();$('review-message').textContent='';$('delivery-content').hidden=true;$('delivery-state').hidden=false;$('lookup-form').hidden=false;$('state-title').textContent='Projen burada.';$('state-description').textContent=description;$('state-retry').hidden=true;$('approval-dialog').close();$('lookup-error').textContent='';$('access-code').value='';
  }
  function unavailable(description){
    if(!previewId){showLookup(description);return;}
    generation++;delivery=null;clearMedia();$('delivery-content').hidden=true;$('delivery-state').hidden=false;$('lookup-form').hidden=true;$('state-title').textContent='Önizleme açılamadı.';$('state-description').textContent=description;$('state-retry').hidden=false;$('approval-dialog').close();
  }
  function safeAssetURL(value){try{const url=new URL(value,location.origin);return url.origin===location.origin&&(url.pathname.startsWith('/api/delivery/media/')||(previewId&&url.pathname.startsWith('/api/admin/deliveries/')))?url.pathname:null;}catch{return null;}}
  function assetLabel(assetId){const index=delivery?.files.findIndex(asset=>asset.id===assetId);return index>=0?`Video ${index+1}`:'Önceki sürüm videosu';}
  function closeEditor(){$('note-editor').hidden=true;editing=null;$('note-error').textContent='';}
  function startNote(assetId,index=null){
    if(!editable())return;if(index===null&&drafts.length>=20){message('Bir turda en fazla 20 zaman kodlu not ekleyebilirsin.',true);return;}
    const asset=delivery.files.find(file=>file.id===assetId);if(!asset?.mimeType.startsWith('video/'))return;
    const player=players.get(assetId);if(player)player.pause();editing={assetId,index};const draft=index===null?null:drafts[index];
    $('note-asset-label').textContent=assetLabel(assetId);$('note-time').max=String(Number.isFinite(player?.duration)?Math.min(10800,player.duration):10800);$('note-time').value=String(draft?.timeSeconds??Math.min(10800,Math.round((player?.currentTime||0)*10)/10));$('note-message').value=draft?.message||'';$('note-error').textContent='';$('note-save').textContent=draft?'Notu güncelle ✓':'Notu ekle +';$('note-editor').hidden=false;$('note-message').focus();
  }
  function paintDrafts(){
    $('draft-notes').replaceChildren(...drafts.map((draft,index)=>{
      const li=node('li','draft-note');li.append(node('strong','',`${assetLabel(draft.assetId)} · ${timestamp(draft.timeSeconds)}`),node('p','',draft.message));const actions=node('div','note-actions');
      const edit=node('button','text-button','Düzenle');edit.type='button';edit.dataset.editNote=String(index);edit.addEventListener('click',()=>startNote(draft.assetId,index));
      const remove=node('button','text-button','Kaldır');remove.type='button';remove.dataset.removeNote=String(index);remove.addEventListener('click',()=>{if(!editable())return;drafts.splice(index,1);closeEditor();paintDrafts();});actions.append(edit,remove);li.append(actions);return li;
    }));$('draft-count').hidden=drafts.length===0;$('draft-count').textContent=`${drafts.length} / 20 zaman kodlu not · Hepsi tek revizyon turunda gönderilecek.`;updateActions();
  }
  function renderOverview(payload){
    const project=payload.project||{},budget=payload.revisions||{included:3,used:0,remaining:3,nextFeeCents:0,extraFeeCentsTotal:0};const details=$('project-details');details.replaceChildren();
    const deliverables=Array.isArray(project.deliverables)?project.deliverables.join('\n'):project.deliverables;
    for(const [label,value]of [['Durum',stages[project.stage]||project.stage],['Anlaşılan kapsam',project.scope],['Teslim edilecekler',deliverables],['Hedef teslim',project.deadline?new Intl.DateTimeFormat('tr-TR',{dateStyle:'medium'}).format(new Date(project.deadline+'T12:00:00')):null]]){
      if(!value)continue;const group=node('div');group.append(node('dt','',label),node('dd','',value));details.append(group);
    }
    if(!details.children.length)details.append(node('p','','Stüdyo projenin kapsam ve takvim bilgilerini bu alanda paylaşacak.'));
    $('revision-counter').textContent=`${budget.used} tur kullanıldı · ${budget.remaining} dahil hak kaldı`;
    $('revision-policy').textContent='İlk 3 revizyon turu dahil. Sonraki her tur 1.000 TL.';
    $('revision-total').hidden=!budget.extraFeeCentsTotal;$('revision-total').textContent=`Onayladığın ek revizyon bedeli: ${money(budget.extraFeeCentsTotal)}`;
    $('fee-confirmation-row').hidden=Number(budget.nextFeeCents)<=0;$('fee-confirmation').required=Number(budget.nextFeeCents)>0;$('fee-confirmation-label').textContent=`3 dahil revizyon turunu kullandım. Bu ek tur için ${money(budget.nextFeeCents)} bedeli kabul ediyorum.`;
  }
  function render(payload){
    const changed=delivery&&(delivery.id!==payload.id||delivery.version!==payload.version);const hadDrafts=drafts.length>0||Boolean($('revision-message').value.trim())||Boolean(pendingRevision);
    if(changed){drafts=[];pendingRevision=null;closeEditor();$('revision-message').value='';$('fee-confirmation').checked=false;if(hadDrafts)message('Yeni bir teslim sürümü geldi. Önceki taslak notların temizlendi; güncel dosyaları inceleyerek yeni not ekle.');}
    if(payload.status!=='pending'){drafts=[];pendingRevision=null;closeEditor();$('revision-message').value='';$('fee-confirmation').checked=false;}
    delivery=payload;$('delivery-state').hidden=true;$('delivery-content').hidden=false;$('preview-banner').hidden=!previewId;$('delivery-title').textContent=payload.title;$('delivery-description').textContent=payload.description;$('delivery-order').textContent=payload.orderNumber||'';$('delivery-status').textContent=statuses[payload.status]||'Teslim hazır';$('delivery-version').textContent=`Sürüm ${payload.version}`;$('delivery-expiry').textContent=`Son erişim: ${date(payload.expiresAt)}`;$('asset-count').textContent=`${payload.files.length} DOSYA`;renderOverview(payload);clearMedia();
    if(!payload.files.length)$('delivery-files').append(node('p','files-empty','Stüdyo dosyalarını buraya ekleyecek. Birazdan tekrar kontrol edebilirsin.'));
    payload.files.forEach((asset,index)=>{
      const url=safeAssetURL(asset.url);if(!url)return;const card=node('article','asset-card');const mime=asset.mimeType;const isVideo=mime.startsWith('video/');const label=isVideo?'Proje videosu':mime==='application/pdf'?'Proje dokümanı':'Proje görseli';
      if(isVideo){const video=node('video');video.controls=true;video.preload='metadata';video.playsInline=true;video.src=url;video.setAttribute('aria-label',`${label} ${index+1}`);video.addEventListener('error',()=>message('Bu dosya şu anda oynatılamıyor. Son durumu kontrol edebilir veya dosyayı indirebilirsin.',true));players.set(asset.id,video);card.append(video);}else if(mime.startsWith('image/')){const img=node('img');img.src=url;img.alt=`${payload.title} — ${label.toLocaleLowerCase('tr-TR')} ${index+1}`;img.loading='lazy';card.append(img);}else card.append(node('div','pdf-placeholder','PDF ↗'));
      const bar=node('div','asset-bar');const info=node('div');info.append(node('strong','',`${String(index+1).padStart(2,'0')} / ${label}`),node('small','',`${mime.split('/')[1].toUpperCase()} · ${size(asset.size)}`));const link=node('a','asset-download','Dosyayı indir ↓');link.href=url;link.download='';bar.append(info,link);card.append(bar);
      if(isVideo&&!previewId){const add=node('button','timestamp-add','Bu ana not ekle +');add.type='button';add.dataset.addNote=asset.id;add.addEventListener('click',()=>startNote(asset.id));card.append(add);}$('delivery-files').append(card);
    });
    $('feedback-list').replaceChildren();$('feedback-empty').hidden=payload.feedback.length>0;[...payload.feedback].reverse().forEach(item=>{
      const li=node('li','feedback-item');const meta=node('div');const time=node('time','',date(item.createdAt));time.dateTime=item.createdAt;meta.append(node('strong','',`${item.action==='approve'?'Onaylandı':`Revizyon ${item.roundNumber?`${item.roundNumber}. tur`:''}`} · Sürüm ${item.version}`),time);if(item.feeCents)meta.append(node('span','feedback-fee',`${money(item.feeCents)} ek tur · kabul edildi`));const body=node('div');if(item.message)body.append(node('p','',item.message));else if(item.action==='approve')body.append(node('p','','Bu sürümdeki teslim onaylandı.'));
      if(Array.isArray(item.notes)&&item.notes.length){const notes=node('ol','feedback-notes');for(const note of item.notes){const entry=node('li');const jump=node('button','timestamp-link',`${assetLabel(note.assetId)} · ${timestamp(note.timeSeconds)}`);jump.type='button';jump.disabled=item.version!==payload.version||!players.has(note.assetId);jump.addEventListener('click',()=>{const player=players.get(note.assetId);if(player){player.pause();player.currentTime=note.timeSeconds;player.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});player.focus();}});entry.append(jump,node('p','',note.message));notes.append(entry);}body.append(notes);}li.append(meta,body);$('feedback-list').append(li);
    });paintDrafts();updateActions();
  }
  async function refresh(){
    if(busy||(!token&&!previewId))return;const ownGeneration=++generation;setBusy(true);message('');$('lookup-form').hidden=true;
    try{const data=previewId?await api(`/api/admin/deliveries/${previewId}/preview`,undefined,{authenticated:false}):await api('/api/delivery/session',{});if(ownGeneration===generation)render(data.delivery);}
    catch(error){if([401,403,404,410].includes(error.status))unavailable(previewId?'Yönetici oturumunu ve teslim kaydını kontrol et.':'Erişim geçersiz, süresi dolmuş veya stüdyo tarafından kapatılmış olabilir. Sipariş bilgilerinle tekrar dene veya stüdyoya ulaş.');else if(!delivery){$('state-title').textContent='Kısa bir ara.';$('state-description').textContent=error.message;$('state-retry').hidden=false;}else message(error.message,true);}
    finally{setBusy(false);}
  }
  $('lookup-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;token='';setBusy(true);$('lookup-error').textContent='';$('state-retry').hidden=true;
    try{const result=await api('/api/delivery/lookup',{orderNumber:$('order-number').value.trim(),accessCode:$('access-code').value.trim()},{authenticated:false});token=result.accessToken;$('access-code').value='';const session=await api('/api/delivery/session',{});render(session.delivery);$('delivery-title').focus();}
    catch(error){$('lookup-error').textContent=token?'Erişimin doğrulandı; dosya oturumu kurulamadı. Tekrar dene düğmesiyle devam edebilirsin.':error.name==='TimeoutError'?'Yanıt gecikti. Lütfen tekrar dene.':error.message;$('state-retry').hidden=!token;}
    finally{setBusy(false);}
  });
  $('code-toggle').addEventListener('click',()=>{const show=$('access-code').type==='password';$('access-code').type=show?'text':'password';$('code-toggle').textContent=show?'Gizle':'Göster';$('code-toggle').setAttribute('aria-pressed',String(show));});
  $('delivery-refresh').addEventListener('click',refresh);$('state-retry').addEventListener('click',refresh);
  $('note-cancel').addEventListener('click',closeEditor);
  $('note-save').addEventListener('click',()=>{
    if(!editing||!editable())return;const timeSeconds=Number($('note-time').value),text=$('note-message').value.trim();if(!$('note-time').value||!Number.isFinite(timeSeconds)||timeSeconds<0||timeSeconds>Number($('note-time').max)||!text){$('note-error').textContent='Videonun süresi içinde bir zaman ve not ekle.';return;}
    const draft={assetId:editing.assetId,timeSeconds:Math.round(timeSeconds*10)/10,message:text};if(editing.index===null)drafts.push(draft);else drafts[editing.index]=draft;closeEditor();paintDrafts();$('revision-message').setCustomValidity('');
  });
  $('revision-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!delivery||previewId||delivery.status!=='pending')return;
    if(!$('note-editor').hidden){$('note-error').textContent='Önce bu notu ekle veya vazgeç.';$('note-message').focus();return;}
    if(!pendingRevision){const text=$('revision-message').value.trim();if(!text&&!drafts.length){$('revision-message').setCustomValidity('Bir genel not veya zaman kodlu not ekle.');$('revision-message').reportValidity();return;}$('revision-message').setCustomValidity('');if(text.length+drafts.reduce((total,note)=>total+note.message.length,0)>12000){message('Bir turdaki notların toplamı en fazla 12.000 karakter olabilir. Lütfen notlarını kısalt.',true);return;}if(Number(delivery.revisions?.nextFeeCents)>0&&!$('fee-confirmation').checked){$('fee-confirmation').reportValidity();return;}
      pendingRevision={action:'revision',message:text,version:delivery.version,requestId:crypto.randomUUID(),notes:drafts.map(note=>({...note})),extraFeeAccepted:Number(delivery.revisions?.nextFeeCents)>0&&$('fee-confirmation').checked};}
    setBusy(true);message('');
    try{const data=await api('/api/delivery/feedback',pendingRevision);render(data.delivery);message('Revizyon turun ve bütün notların stüdyoya ulaştı.');}
    catch(error){if(error.status===400||error.status===413)pendingRevision=null;if(error.status===409)message('Bu sürümün durumu değişmiş olabilir. Son durumu kontrol et; aynı tur tekrar ücretlendirilmez.',true);else message((!error.status?'Yanıt alınamadı. Aynı turu tekrar gönderebilir veya son durumu kontrol edebilirsin. Taslağın korunuyor. ': '')+error.message,true);}
    finally{setBusy(false);}
  });
  $('revision-message').addEventListener('input',()=>$('revision-message').setCustomValidity(''));
  $('approve-open').addEventListener('click',()=>{if(!delivery||busy||previewId||delivery.status!=='pending')return;if(drafts.length||$('revision-message').value.trim()||!$('note-editor').hidden){message('Gönderilmemiş revizyon notların var. Onaylamak için önce taslak notlarını kaldır ve genel not alanını temizle.',true);return;}$('approval-confirmation').checked=false;$('approval-error').textContent='';$('approval-version').textContent=`Sürüm ${delivery.version} · ${delivery.files.length} dosya. Onayın proje ekibine iletilecek.`;$('approval-dialog').showModal();});
  $('approve-cancel').addEventListener('click',()=>$('approval-dialog').close());
  $('approval-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!delivery||previewId||!$('approval-confirmation').checked)return;setBusy(true);$('approval-error').textContent='';
    try{const data=await api('/api/delivery/feedback',{action:'approve',message:'',version:delivery.version,confirmation:true});render(data.delivery);$('approval-dialog').close();message('Onayın stüdyoya ulaştı. Birlikte iyi bir iş çıkardık.');}
    catch(error){$('approval-error').textContent=error.status===409?'Teslim güncellendi. İncelemeye dönüp son durumu kontrol et.':error.message;$('approval-error').classList.add('is-error');}finally{setBusy(false);}
  });
  $('testimonial-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||previewId||delivery?.status!=='approved'||reviewSubmitted||!$('review-consent').checked)return;
    const body={displayName:$('review-name').value.trim(),company:$('review-company').value.trim(),rating:Number($('review-rating').value),text:$('review-text').value.trim(),publicationConsent:true};setBusy(true);$('review-message').textContent='';
    try{await api('/api/delivery/review',body);reviewSubmitted=true;$('review-message').classList.remove('is-error');$('review-message').textContent='Teşekkürler! Yorumun stüdyoya ulaştı; yayınlanmadan önce kontrol edilecek.';}
    catch(error){$('review-message').classList.add('is-error');$('review-message').textContent=error.message;}finally{setBusy(false);}
  });
  $('delivery-exit').addEventListener('click',()=>{if(busy)return;if((drafts.length||$('revision-message').value.trim())&&!confirm('Gönderilmemiş notların silinecek. Proje görünümünden çıkılsın mı?'))return;location.replace('/teslim');});
  window.addEventListener('pagehide',()=>{for(const player of players.values())player.pause();});
  if(previewId||token){$('lookup-form').hidden=true;$('state-title').textContent=previewId?'Müşteri görünümü hazırlanıyor.':'Projen hazırlanıyor.';$('state-description').textContent='Teslim bilgileri kontrol ediliyor…';refresh();}
})();
