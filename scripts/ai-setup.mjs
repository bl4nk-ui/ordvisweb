import {Store} from '../lib/store.mjs';
import {readLine} from '../lib/terminal.mjs';
let store;
try{
 store=new Store({});const admin=store.getAdminState();
 if(!admin?.mfaEnabled)throw new Error('Önce yönetici hesabını ve panelde iki aşamalı doğrulamayı kurun.');
 console.log('\nORDVIS / GROQ ANAHTAR KURULUMU\nAnahtar gizli alınır ve sunucuda şifreli saklanır; otomasyon buradan açılmaz.\n');
 const username=await readLine('Yönetici kullanıcı adı: ');const password=await readLine('Yönetici parolası: ',true);
 if(!await store.verifyAdmin(username,password))throw new Error('Hesap doğrulanamadı.');
 if(store.getAdminState()?.authVersion!==admin.authVersion)throw new Error('Hesap ayarları değişti. Kurulumu yeniden başlatın.');
 const code=await readLine('Yeni Authenticator veya kurtarma kodu: ',true);
 if(!store.verifyMfa(code))throw new Error('Kod doğrulanamadı. Yeni kodu veya kullanılmamış kurtarma kodunu deneyin.');
 const key=await readLine('Groq API anahtarı: ',true);
 store.setAiKey(key.trim(),{expectedVersion:admin.authVersion});store.audit('groq_key_configured');
 console.log('\nAnahtar kaydedildi. Sunucuyu yeniden başlatın; panelde Otomatik özetler bölümünden saatlik işlemi açın.\nGROQ_API_KEY ortam değişkeni varsa kayıtlı anahtar yerine o kullanılır.');
}catch(error){console.error(error.message);process.exitCode=1;}finally{store?.close();}
