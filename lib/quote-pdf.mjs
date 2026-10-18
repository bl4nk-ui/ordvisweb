import {readFile} from 'node:fs/promises';
import {PDFDocument,rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const black=rgb(.043,.043,.047),gray=rgb(.40,.40,.43),line=rgb(.84,.84,.85),white=rgb(.96,.96,.95);
const pageWidth=595.28,pageHeight=841.89,margin=46,usable=pageWidth-margin*2;
const money=new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'});
const statuses={draft:'TASLAK',sent:'PAYLAŞILDI',accepted:'KABUL EDİLDİ',rejected:'KABUL EDİLMEDİ'};
let resources;
function assets(){return resources??=Promise.all([
 readFile(new URL('../assets/fonts/DejaVuSans.ttf',import.meta.url)),
 readFile(new URL('../public/media/ordvis-logo.png',import.meta.url)),
]);}

/** Render a self-contained PDF. Customer text is drawn as text, never HTML. */
export async function createQuotePdf(quote){
 if(!quote||!Array.isArray(quote.items)||quote.items.length>20||!Number.isSafeInteger(quote.totalCents)||quote.totalCents<0)throw new TypeError('Geçersiz teklif.');
 const document=await PDFDocument.create();document.registerFontkit(fontkit);
 const [fontBytes,logoBytes]=await assets();
 const font=await document.embedFont(fontBytes,{subset:true}),logo=await document.embedPng(logoBytes);
 const characters=new Set(font.getCharacterSet());
 const clean=value=>[...String(value??'').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g,'')].map(char=>char==='\n'||characters.has(char.codePointAt(0))?char:'?').join('');
 const date=value=>{if(!value)return 'Belirtilmedi';const parsed=new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T12:00:00Z':value);return Number.isNaN(parsed.getTime())?'Belirtilmedi':new Intl.DateTimeFormat('tr-TR',{dateStyle:'long',timeZone:'Europe/Istanbul'}).format(parsed);};
 document.setTitle(clean(quote.title||'Ordvis Creative teklif'));document.setAuthor('Ordvis Creative');document.setCreator('Ordvis Creative');document.setSubject('Proje kapsamı ve fiyat teklifi');
 let page,y;
 const text=(value,x,baseline,size=10,color=black)=>page.drawText(clean(value),{x,y:baseline,size,font,color});
 const right=(value,end,baseline,size=10,color=black)=>{const content=clean(value);text(content,end-font.widthOfTextAtSize(content,size),baseline,size,color);};
 function newPage(first=false){
  page=document.addPage([pageWidth,pageHeight]);
  if(first){
   page.drawRectangle({x:0,y:pageHeight-128,width:pageWidth,height:128,color:black});
   page.drawImage(logo,{x:margin,y:pageHeight-98,width:85,height:85*868/1134});
   text('PROJE TEKLİFİ',285,pageHeight-55,17,white);
   text(clean(quote.number||quote.id||'').slice(0,60),285,pageHeight-76,9,white);
   text(statuses[quote.status]||'TEKLİF',285,pageHeight-96,8,rgb(.7,.7,.72));y=pageHeight-171;
  }else{text('ORDVIS CREATIVE / PROJE TEKLİFİ',margin,pageHeight-39,8,gray);right(quote.number||'',pageWidth-margin,pageHeight-39,8,gray);page.drawLine({start:{x:margin,y:pageHeight-50},end:{x:pageWidth-margin,y:pageHeight-50},thickness:.7,color:line});y=pageHeight-77;}
 }
 function space(height){if(y-height<78)newPage();}
 function wrap(value,width,size){
  const output=[];
  for(const paragraph of clean(value).split('\n')){
   let current='';
   for(const word of paragraph.split(/\s+/).filter(Boolean)){
    const candidate=current?current+' '+word:word;
    if(font.widthOfTextAtSize(candidate,size)<=width){current=candidate;continue;}
    if(current){output.push(current);current='';}
    for(const char of word){if(current&&font.widthOfTextAtSize(current+char,size)>width){output.push(current);current='';}current+=char;}
   }
   output.push(current);
  }
  return output;
 }
 function paragraph(value,{size=10,color=black,width=usable,gap=15}={}){for(const row of wrap(value,width,size)){space(gap);text(row,margin,y,size,color);y-=gap;}y-=8;}
 function heading(value){space(48);y-=10;text(value,margin,y,11);y-=23;}
 newPage(true);
 paragraph(quote.title||'Birlikte üretelim.',{size:23,gap:30});
 text('HAZIRLANAN',margin,y,7,gray);text('TEKLİF TARİHİ',340,y,7,gray);y-=18;
 const customer=clean([quote.clientBrand,quote.clientName].filter(Boolean).join(' / '));
 const customerLines=wrap(customer||'Proje müşterisi',265,10);
 const top=y;customerLines.forEach(row=>{space(15);text(row,margin,y,10);y-=15;});text(date(quote.createdAt),340,top,9);y-=16;
 heading('Hizmetler ve üretim kapsamı');
 function tableHeader(){space(32);page.drawRectangle({x:margin,y:y-9,width:usable,height:24,color:rgb(.94,.94,.94)});text('HİZMET',margin+9,y,7,gray);text('ADET',300,y,7,gray);right('BİRİM FİYAT',442,y,7,gray);right('TUTAR',pageWidth-margin-8,y,7,gray);y-=31;}
 tableHeader();
 for(const item of quote.items){
  if(!Number.isSafeInteger(item.quantity)||!Number.isSafeInteger(item.unitPriceCents)||!Number.isSafeInteger(item.lineTotalCents))throw new TypeError('Geçersiz teklif kalemi.');
  const rows=wrap(item.description,238,9);if(y-Math.min(rows.length,35)*14-18<78){newPage();tableHeader();}
  const baseline=y;text(String(item.quantity),300,baseline,9);right(money.format(item.unitPriceCents/100),442,baseline,9);right(money.format(item.lineTotalCents/100),pageWidth-margin-8,baseline,9);
  for(const row of rows){if(y<91){newPage();tableHeader();}text(row,margin+9,y,9);y-=14;}
  y-=8;page.drawLine({start:{x:margin,y},end:{x:pageWidth-margin,y},color:line,thickness:.5});y-=17;
 }
 space(90);y-=8;text('TOPLAM TEKLİF',margin,y,8,gray);right(money.format(quote.totalCents/100),pageWidth-margin,y-3,22);y-=33;
 paragraph('Para birimi: Türk lirası (TRY). Bu belge teklif niteliğindedir.',{size:8,color:gray,gap:12});
 if(quote.scope){heading('Projenin kapsamı');paragraph(quote.scope);}
 if(quote.deliverables){heading('Teslim edilecekler');paragraph(quote.deliverables);}
 heading('Planlanan teslim');paragraph(date(quote.deadline));
 heading('Revizyon politikası');
 paragraph('3 revizyon turu dahildir. Sonraki her ek revizyon turu 1.000,00 TL olarak ücretlendirilir. Bir turda birden fazla düzenleme notu iletilebilir. Ücretli tur, müşterinin açık onayıyla açılır.');
 if(quote.terms){heading('Teklif şartları');paragraph(quote.terms);}
 if(quote.acceptedAt){heading('Kabul kaydı');paragraph(date(quote.acceptedAt),{color:gray});}
 heading('Birlikte iyi bir iş çıkaralım.');paragraph('ordviscreative@gmail.com  /  0530 716 88 08',{size:9,color:gray});
 const pages=document.getPages();pages.forEach((sheet,index)=>{page=sheet;sheet.drawLine({start:{x:margin,y:49},end:{x:pageWidth-margin,y:49},thickness:.5,color:line});text('ORDVIS CREATIVE',margin,32,7,gray);right(`${index+1} / ${pages.length}`,pageWidth-margin,32,7,gray);});
 return Buffer.from(await document.save());
}
