const menu = document.querySelector('.menu');
const nav = document.querySelector('.header nav');
menu.addEventListener('click', () => {const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Menüyü kapat':'Menüyü aç');nav.classList.toggle('open',open);});
nav.addEventListener('click',event=>{if(event.target.closest('a')){nav.classList.remove('open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Menüyü aç');}});
document.querySelectorAll('[data-plan]').forEach(link=>link.addEventListener('click',()=>{document.querySelector('#plan').value=link.dataset.plan;}));
document.querySelector('#brief-form').addEventListener('submit',event=>{
 event.preventDefault();
 const data=new FormData(event.currentTarget);
 const text=`Merhaba Ordvis Creative!\n\nMarka / proje: ${data.get('brand').trim()}\nİlgilendiğim hizmet: ${data.get('plan')}\n\n${data.get('brief').trim()}`;
 const link=document.createElement('a');
 link.href='https://wa.me/905307168808?text='+encodeURIComponent(text);
 link.target='_blank';link.rel='noopener noreferrer';link.click();
 document.querySelector('#form-status').textContent='WhatsApp bağlantısı açıldı. Mesajınız, siz gönderene kadar ajansa iletilmez.';
});
const privacy=document.querySelector('#privacy');document.querySelector('#privacy-open').addEventListener('click',()=>privacy.showModal());document.querySelector('#privacy-close').addEventListener('click',()=>privacy.close());privacy.addEventListener('click',event=>{if(event.target===privacy){const rect=privacy.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)privacy.close();}});
