const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const menu = document.querySelector('.menu');
const nav = document.querySelector('.header nav');
function closeMenu(){nav.classList.remove('open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Menüyü aç');}
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Menüyü kapat':'Menüyü aç');nav.classList.toggle('open',open);});
nav.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu.getAttribute('aria-expanded')==='true'){closeMenu();menu.focus();}});
const wideScreen=matchMedia('(min-width: 901px)');wideScreen.addEventListener('change',event=>{if(event.matches)closeMenu();});
const form=document.querySelector('#brief-form');
if(form){
 const select=form.querySelector('#plan');const requested=new URLSearchParams(location.search).get('paket');
 if([...select.options].some(option=>option.value===requested))select.value=requested;
 const status=document.querySelector('#form-status');const submit=form.querySelector('[type="submit"]');const label=submit.querySelector('.submit-label');
 const steps=[...form.querySelectorAll('[data-brief-step]')];const progress=[...form.querySelectorAll('.brief-progress li')];
 const back=form.querySelector('#brief-back');const next=form.querySelector('#brief-next');
 let requestId=crypto.randomUUID();let sending=false;let currentStep=0;
 form.noValidate=true;
 function showStep(index,focus=false){
  currentStep=index;steps.forEach((step,i)=>{step.hidden=i!==index;});
  progress.forEach((item,i)=>{if(i===index)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');item.dataset.done=String(i<index);});
  back.hidden=index===0;next.hidden=index===steps.length-1;submit.hidden=index!==steps.length-1;
  if(focus)steps[index].querySelector('h3').focus({preventScroll:false});
 }
 function validateStep(index){
  const invalid=[...steps[index].querySelectorAll('input,select,textarea')].find(field=>!field.checkValidity());
  if(!invalid)return true;
  showStep(index);invalid.reportValidity();return false;
 }
 next.addEventListener('click',()=>{if(!sending&&validateStep(currentStep))showStep(currentStep+1,true);});
 back.addEventListener('click',()=>{if(!sending)showStep(Math.max(0,currentStep-1),true);});
 showStep(0);
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(sending)return;
  if(currentStep<steps.length-1){if(validateStep(currentStep))showStep(currentStep+1,true);return;}
  for(let i=0;i<steps.length;i++)if(!validateStep(i))return;
  const data=new FormData(form);const body=Object.fromEntries(data);body.consent=data.get('consent')==='on';body.requestId=requestId;
  body.briefDetails={service:data.get('service'),goal:data.get('goal').trim(),location:data.get('location').trim(),deadline:data.get('deadline')||null,budgetRange:data.get('budgetRange')};
  for(const key of ['service','goal','location','deadline','budgetRange'])delete body[key];
  sending=true;submit.disabled=true;back.disabled=true;next.disabled=true;form.setAttribute('aria-busy','true');label.textContent='Talebiniz gönderiliyor…';status.textContent='';
  try{
   const response=await fetch('/api/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
   const result=await response.json();if(!response.ok)throw new Error(result.error||'Talebiniz gönderilemedi.');
   status.textContent=result.message;form.dataset.state='success';form.reset();requestId=crypto.randomUUID();showStep(0);
  }catch(error){form.dataset.state='error';status.textContent=error.name==='TimeoutError'?'Yanıt gecikti. Bağlantınızı kontrol edip tekrar deneyin.':error.message==='Failed to fetch'?'Bağlantı kurulamadı. Lütfen tekrar deneyin veya bize e-posta ile ulaşın.':error.message;}
  finally{sending=false;submit.disabled=false;back.disabled=false;next.disabled=false;form.removeAttribute('aria-busy');label.textContent='Talebimi gönder';}
 });
}
const privacy=document.querySelector('#privacy');
document.querySelectorAll('#privacy-open,[data-privacy]').forEach(button=>button.addEventListener('click',()=>privacy.showModal()));
document.querySelector('#privacy-close').addEventListener('click',()=>privacy.close());
privacy.addEventListener('click',event=>{if(event.target===privacy){const r=privacy.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)privacy.close();}});
const preview=document.querySelector('.editor-preview');
if(preview){
 const labels={raw:'01 / HAM GÖRÜNTÜ',grade:'02 / RENK DÜZENLEME',vfx:'03 / EFEKT & MOTION'};
 const tabs=document.querySelectorAll('.look-tabs button');
 tabs.forEach(tab=>tab.addEventListener('click',()=>{preview.dataset.look=tab.dataset.look;document.querySelector('#look-label').textContent=labels[tab.dataset.look];tabs.forEach(button=>button.setAttribute('aria-pressed',String(button===tab)));}));
 const play=document.querySelector('#timeline-play');const seek=document.querySelector('#timeline-seek');const timeline=document.querySelector('.timeline');const output=document.querySelector('#timecode');
 let playing=false;let progress=0;let lastTime=0;let frame=0;
 function paint(){seek.value=String(progress);seek.setAttribute('aria-valuetext',`${progress.toFixed(1)} saniye / 12 saniye`);timeline.style.setProperty('--progress',String(progress/12));output.value=`00:${progress.toFixed(1).padStart(4,'0')} / 00:12`;}
 function setPlaying(value){playing=value;play.setAttribute('aria-pressed',String(value));play.setAttribute('aria-label',value?'Zaman çizelgesini duraklat':'Zaman çizelgesini oynat');play.textContent=value?'Ⅱ Duraklat':'▶ Oynat';preview.classList.toggle('is-playing',value);cancelAnimationFrame(frame);if(value){lastTime=performance.now();frame=requestAnimationFrame(tick);}}
 function tick(time){if(!playing)return;progress=Math.min(12,progress+(time-lastTime)/1000);lastTime=time;paint();if(progress>=12)setPlaying(false);else frame=requestAnimationFrame(tick);}
 play.addEventListener('click',()=>{if(progress>=12)progress=0;setPlaying(!playing);paint();});
 seek.addEventListener('input',()=>{progress=Number(seek.value);lastTime=performance.now();paint();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)setPlaying(false);});
 reducedMotion.addEventListener('change',()=>setPlaying(false));
 paint();
}
