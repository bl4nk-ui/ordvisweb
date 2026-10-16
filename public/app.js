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
 form.addEventListener('submit',event=>{
  event.preventDefault();const data=new FormData(form);
  const text=`Merhaba Ordvis Creative!\n\nMarka / proje: ${String(data.get('brand')).trim()}\nİlgilendiğim hizmet: ${data.get('plan')}\n\n${String(data.get('brief')).trim()}`;
  const link=document.createElement('a');link.href='https://wa.me/905307168808?text='+encodeURIComponent(text);link.target='_blank';link.rel='noopener noreferrer';link.click();
  document.querySelector('#form-status').textContent='WhatsApp bağlantısı açıldı. Mesajınız, siz gönderene kadar ajansa iletilmez.';
 });
}
const privacy=document.querySelector('#privacy');
document.querySelector('#privacy-open').addEventListener('click',()=>privacy.showModal());
document.querySelector('#privacy-close').addEventListener('click',()=>privacy.close());
privacy.addEventListener('click',event=>{if(event.target===privacy){const r=privacy.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)privacy.close();}});
const flight=document.querySelector('.drone-flight');const replay=document.querySelector('#replay-flight');
if(flight){
 const pause=document.querySelector('#pause-flight');const stage=document.querySelector('.drone-stage');
 function pauseFlight(value){stage.classList.toggle('is-paused',value);pause.setAttribute('aria-pressed',String(value));pause.textContent=value?'Hareketi sürdür':'Hareketi duraklat';}
 const updateMotion=()=>{replay.disabled=reducedMotion.matches;pause.disabled=reducedMotion.matches;replay.textContent=reducedMotion.matches?'Hareket azaltma açık':'Uçuşu tekrar izle ↻';};
 updateMotion();reducedMotion.addEventListener('change',updateMotion);
 pause.addEventListener('click',()=>pauseFlight(!stage.classList.contains('is-paused')));
 replay.addEventListener('click',()=>{pauseFlight(false);flight.getAnimations().forEach(animation=>{animation.cancel();animation.play();});});
}
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
