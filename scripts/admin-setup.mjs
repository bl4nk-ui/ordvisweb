import readline from 'node:readline';
import {Store} from '../lib/store.mjs';
function readLine(prompt,hidden=false){
 return new Promise((resolve,reject)=>{
  if(!process.stdin.isTTY){reject(new Error('Parola kurulumu için VS Code veya bilgisayar terminalinizi kullanın.'));return;}
  readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();let value='';
  const cleanup=()=>{process.stdin.off('keypress',handler);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
  const handler=(str,key={})=>{
   if(key.ctrl&&key.name==='c'){cleanup();reject(new Error('Kurulum iptal edildi.'));return;}
   if(key.name==='return'||key.name==='enter'){cleanup();resolve(value);return;}
   if(key.name==='backspace'){if(value){value=[...value].slice(0,-1).join('');process.stdout.write('\b \b');}return;}
   if(str&&!key.ctrl&&!key.meta&&!/\p{C}/u.test(str)){value+=str;process.stdout.write(hidden?'*'.repeat([...str].length):str);}
  };
  process.stdin.on('keypress',handler);process.stdout.write(prompt);
 });
}
let store;
try{
 store=new Store({});
 console.log('\nORDVIS / YÖNETİCİ HESABI\nParola yalnız bu sunucuda güçlü bir hash olarak saklanır.\n');
 const initialVersion=store.getAdminState()?.authVersion??0;
 if(store.hasAdmin()){
  console.log('Mevcut hesabı değiştirmek için önce yönetici parolanızı doğrulayın.');
  const username=await readLine('Mevcut kullanıcı adı: ');const password=await readLine('Mevcut parola: ',true);
  if(!await store.verifyAdmin(username,password))throw new Error('Mevcut hesap doğrulanamadı.');
  if(store.getAdminState().authVersion!==initialVersion)throw new Error('Hesap değişti; kurulumu yeniden başlatın.');
  if(store.getAdminState().mfaEnabled){const code=await readLine('Authenticator veya kurtarma kodu: ',true);if(!store.verifyMfa(code))throw new Error('İkinci doğrulama başarısız. Yeni kodu veya kullanılmamış kurtarma kodunu deneyin.');}
 }
 const username=await readLine('Yeni kullanıcı adı (en az 3 karakter): ');
 const password=await readLine('Yeni parola (en az 12 karakter): ',true);
 const confirm=await readLine('Parolayı tekrar girin: ',true);
 if(password!==confirm)throw new Error('Parolalar eşleşmiyor.');
 await store.initializeAdmin(username.trim(),password,{expectedVersion:initialVersion});
 console.log('\nHesap kaydedildi. Çalışan sunucuyu Ctrl+C ile durdurup npm run dev ile yeniden başlatın.\nArdından sitenizin /admin adresinden giriş yapın.');
}catch(error){console.error(error.message);process.exitCode=1;}finally{store?.close();}
