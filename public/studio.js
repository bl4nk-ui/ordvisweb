(() => {
 'use strict';
 const categories={production:'Prodüksiyon',drone:'Drone',editing:'Kurgu & efekt',digital:'Dijital'};
 const create=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
 function mediaURL(media){
  if(!media||typeof media.url!=='string')return null;
  try{const url=new URL(media.url,location.origin);return url.origin===location.origin&&url.pathname.startsWith('/media/projects/')?url.pathname+url.search:null;}catch{return null;}
 }
 const isVideo=media=>media&&['video/mp4','video/webm'].includes(media.mimeType);
 const isImage=media=>media&&['image/jpeg','image/png','image/webp'].includes(media.mimeType);
 async function request(path){
  const response=await fetch(path,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!response.ok)throw new Error(response.status===404?'Bu proje yayında değil veya kaldırılmış olabilir.':result.error||'Projeler şu anda yüklenemedi.');
  return result;
 }
 function failure(element,error,retry){
  const message=error.name==='TimeoutError'?'Bağlantı gecikti. Lütfen tekrar deneyin.':error instanceof TypeError?'Bağlantı kurulamadı. Lütfen tekrar deneyin.':error.message;
  element.replaceChildren(document.createTextNode(message+' '));
  const button=create('button','studio-retry','Tekrar dene');button.type='button';button.addEventListener('click',retry,{once:true});element.append(button);
 }
 const grid=document.querySelector('#portfolio-grid');
 if(grid){
  const status=document.querySelector('#portfolio-status');const empty=document.querySelector('#portfolio-empty');const emptyCopy=document.querySelector('#portfolio-empty-copy');const count=document.querySelector('#portfolio-count');
  const filters=[...document.querySelectorAll('[data-category]')];let projects=[];let selected='all';
  function card(project){
   const link=create('a','portfolio-card');link.href='/isler/'+encodeURIComponent(project.slug);
   const art=create('div','portfolio-card-image');const cover=mediaURL(project.media?.cover);
   const image=create('img',cover?'':'portfolio-no-cover');image.src=cover||'/media/ordvis-mark.png';image.alt=cover?project.title+' — proje kapağı':'';image.loading='lazy';image.decoding='async';
   art.append(image,create('span','portfolio-card-category',categories[project.category]||'Ordvis Creative'));
   const caption=create('div','portfolio-card-caption');const description=create('div');description.append(create('h3','',project.title));if(project.summary)description.append(create('p','',project.summary.length>260?project.summary.slice(0,257)+'…':project.summary));
   const arrow=create('span','portfolio-card-arrow','↗');arrow.setAttribute('aria-hidden','true');caption.append(description,arrow);link.append(art,caption);return link;
  }
  function paint(){
   const shown=projects.filter(project=>selected==='all'||project.category===selected);
   grid.replaceChildren(...shown.map(card));count.textContent=shown.length+' proje';empty.hidden=shown.length>0;
   emptyCopy.textContent=projects.length===0?'Yayına aldığımız projeler bu alanda yer alacak. Aklınızdaki projeyi birlikte şekillendirelim.':'Bu alanda henüz yayında bir projemiz yok. Diğer alanlardaki işlerimizi keşfedebilir veya kendi projenizi bizimle paylaşabilirsiniz.';
   filters.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.category===selected)));
  }
  filters.forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.category;paint();}));
  async function load(){
   status.textContent='Projeler yükleniyor…';grid.setAttribute('aria-busy','true');empty.hidden=true;
   try{const result=await request('/api/projects');projects=Array.isArray(result.projects)?result.projects.filter(project=>project&&typeof project.slug==='string'&&typeof project.title==='string'):[];paint();status.textContent='';}
   catch(error){count.textContent='';failure(status,error,load);}
   finally{grid.setAttribute('aria-busy','false');}
  }
  load();
 }
 const content=document.querySelector('#project-content');
 if(content){
  const status=document.querySelector('#project-status');
  function image(media,alt){const url=mediaURL(media);if(!url||!isImage(media))return null;const img=create('img');img.src=url;img.alt=alt;img.decoding='async';return img;}
  function video(media,label,controls=false){const url=mediaURL(media);if(!url||!isVideo(media))return null;const player=create('video');player.src=url;player.preload=controls?'none':'metadata';player.controls=controls;player.playsInline=true;player.setAttribute('aria-label',label);player.append(document.createTextNode('Tarayıcınız bu videoyu desteklemiyor.'));return player;}
  function comparison(beforeMedia,afterMedia){
   const before=video(beforeMedia,'Projenin önceki aşaması')||image(beforeMedia,'Projenin önceki aşaması');
   const after=video(afterMedia,'Projenin son aşaması')||image(afterMedia,'Projenin son aşaması');
   if(!before||!after)return;
   document.querySelector('#comparison-before').replaceChildren(before);document.querySelector('#comparison-after').replaceChildren(after);document.querySelector('#project-comparison').hidden=false;
   const controls=document.querySelector('.comparison-controls');const message=document.querySelector('#comparison-status');
   if(before.tagName!=='VIDEO'||after.tagName!=='VIDEO'){
    controls.hidden=true;document.querySelector('.comparison-sound').hidden=true;
    document.querySelector('#project-comparison .section-heading p').textContent='Üretimin iki aşamasını yan yana inceleyin.';
    for(const item of [before,after])if(item.tagName==='VIDEO'){item.controls=true;item.preload='none';}
    message.textContent='';return;
   }
   before.muted=true;after.muted=true;
   const play=document.querySelector('#comparison-play');const position=document.querySelector('#comparison-position');const output=document.querySelector('#comparison-time');
   let duration=0;let playing=false;let playAttempt=0;
   function timestamp(value){const seconds=Math.max(0,Math.floor(value||0));return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
   function paint(){position.value=String(Math.min(duration,before.currentTime));output.value=timestamp(before.currentTime)+' / '+timestamp(duration);position.setAttribute('aria-valuetext',`${timestamp(before.currentTime)} / ${timestamp(duration)}`);}
   function pause(){playAttempt++;before.pause();after.pause();playing=false;play.setAttribute('aria-pressed','false');play.replaceChildren(document.createTextNode('Karşılaştırmayı oynat '));const icon=create('span','','▶');icon.setAttribute('aria-hidden','true');play.append(icon);}
   function ready(){
    if(!Number.isFinite(before.duration)||!Number.isFinite(after.duration)||before.duration<=0||after.duration<=0)return;
    duration=Math.min(before.duration,after.duration);position.max=String(duration);position.disabled=false;play.disabled=false;message.textContent=Math.abs(before.duration-after.duration)>.5?'Karşılaştırma, iki videonun ortak süresince oynatılır.':'';paint();
   }
   for(const player of [before,after]){
    player.addEventListener('loadedmetadata',ready);player.addEventListener('durationchange',ready);
    player.addEventListener('error',()=>{pause();play.disabled=true;position.disabled=true;message.textContent='Karşılaştırma videosu yüklenemedi. Sayfayı yenileyerek tekrar deneyebilirsiniz.';});
    player.addEventListener('ended',()=>{pause();paint();});
   }
   before.addEventListener('timeupdate',()=>{if(playing&&Math.abs(after.currentTime-before.currentTime)>.18)after.currentTime=before.currentTime;if(before.currentTime>=duration&&duration>0)pause();paint();});
   play.addEventListener('click',async()=>{
    if(playing){pause();return;}
    if(before.currentTime>=duration-.05){before.currentTime=0;after.currentTime=0;}
    after.currentTime=before.currentTime;const attempt=++playAttempt;play.disabled=true;
    try{await Promise.all([before.play(),after.play()]);if(attempt!==playAttempt){before.pause();after.pause();return;}playing=true;play.setAttribute('aria-pressed','true');play.replaceChildren(document.createTextNode('Duraklat '));const icon=create('span','','Ⅱ');icon.setAttribute('aria-hidden','true');play.append(icon);}
    catch{pause();message.textContent='Video oynatılamadı. Bağlantınızı kontrol edip tekrar deneyin.';}
    finally{play.disabled=duration===0;}
   });
   position.addEventListener('input',()=>{const time=Math.min(duration,Math.max(0,Number(position.value)));before.currentTime=time;after.currentTime=time;paint();});
   document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
   window.addEventListener('pagehide',pause);ready();
  }
  async function load(){
   status.textContent='Proje yükleniyor…';content.setAttribute('aria-busy','true');content.hidden=true;
   try{
    const slug=decodeURIComponent(location.pathname.split('/').filter(Boolean).pop()||'');const {project}=await request('/api/projects/'+encodeURIComponent(slug));if(!project)throw new Error('Proje bulunamadı.');
    document.title=project.title+' — Ordvis Creative';document.querySelector('meta[name=description]').content=project.summary||'Ordvis Creative proje hikâyesi.';
    document.querySelector('#project-title').textContent=project.title;document.querySelector('#project-category').textContent=categories[project.category]||'Ordvis Creative';document.querySelector('#project-summary').textContent=project.summary||'';
    const client=document.querySelector('#project-client');client.textContent=project.clientName||'';client.hidden=!project.clientName;
    const hero=document.querySelector('#project-hero');const cover=image(project.media?.cover,project.title+' — proje kapağı');hero.replaceChildren(...(cover?[cover]:[]));hero.hidden=!cover;
    const story=document.querySelector('#project-story');story.replaceChildren();
    for(const [key,heading,number] of [['challenge','Çıkış noktası','01'],['approach','Yaklaşımımız','02'],['result','Ortaya çıkan iş','03']]){
     if(!project[key])continue;const article=create('article');article.append(create('span','studio-eyebrow',number+' / PROJE HİKÂYESİ'),create('h2','',heading),create('p','',project[key]));story.append(article);
    }
    const film=video(project.media?.video,'Proje filmi',true);
    if(film){document.querySelector('#project-film').replaceChildren(film);document.querySelector('#project-film-section').hidden=false;const url=mediaURL(project.media?.cover);if(url)film.poster=url;film.addEventListener('error',()=>{document.querySelector('#project-film-status').textContent='Video yüklenemedi. Bağlantınızı kontrol edip sayfayı yenileyin.';});}
    if(project.media?.before&&project.media?.after)comparison(project.media.before,project.media.after);
    content.hidden=false;status.textContent='';
   }catch(error){failure(status,error,load);}
   finally{content.setAttribute('aria-busy','false');}
  }
  load();
 }
})();
