# Ordvis Creative

Yedi sayfalı ajans sitesi ve iki aşamalı korunan **stüdyo yönetim paneli** ve kontrollü asistan raporu. Teklif formu bilgileri aynı sunucudaki SQLite veritabanına kaydeder; WhatsApp'a yönlendirme yapmaz. Groq trafiğinin güvenli proxy desteği için sabit sürümlü `undici` bağımlılığı kullanılır. Node.js **22.13 veya üzeri**, tercihen güncel Node.js LTS gereklidir (Node 24 ile doğrulandı).

## Kendi bilgisayarında başlatma

VS Code terminalinde `package.json` bulunan **ordvisweb** klasöründe çalıştırın:

```sh
git pull origin main
npm ci
npm run admin:setup
npm run dev
```

`admin:setup` size bir kullanıcı adı ve en az **12 karakterli parola** sorar. Parola yazarken karakterler yıldızla görünür. Hazır veya varsayılan bir yönetici parolası yoktur; parolayı chat'e, koda veya Git'e yazmayın. Kurulum mevcut hesabı değiştirecekse önce mevcut parolayı doğrular. MFA açıksa mevcut Authenticator veya kullanılmamış kurtarma kodu da istenir; mevcut ikinci faktör korunur. Parola değişikliği tüm oturumları hemen geçersiz kılar. Kurulum sonrasında çalışan sunucuyu yeniden başlatın.

Terminal `Ordvis Creative listening on 3000` yazınca aynı bilgisayarda:

- Site: `http://127.0.0.1:3000`
- Panel: `http://127.0.0.1:3000/admin`

İlk panel girişinde **Güvenlik** ekranı açılır. Mevcut parolanızı doğrulayın, ekrandaki anahtarı Google Authenticator / Microsoft Authenticator / benzer bir TOTP uygulamasına **manuel** ekleyin ve uygulamanın 6 haneli kodunu doğrulayın. Kurtarma kodlarını çevrimdışı güvenli bir yerde saklayın. Bu adım tamamlanmadan talepler ve dışa aktarım kilitlidir. Sonraki girişler parola + Authenticator veya kullanılmamış bir kurtarma kodu gerektirir.

Terminali açık bırakın; durdurmak için Ctrl+C. `npm run dev` ve `npm start` sayfaları otomatik oluşturur. Güncelleme için sunucuyu durdurun, `git pull origin main`, `npm ci`, `npm run dev` çalıştırın. Mevcut hesabı yeniden kurmanız gerekmez. Port doluysa PowerShell'de `$env:PORT=3001; npm run dev`, Bash'te `PORT=3001 npm run dev` kullanın.

`git pull` sırasında `Your local changes ... would be overwritten by merge` hatası çıkarsa, önce sunucuyu Ctrl+C ile durdurun. Yerel düzenlemelerinizi silmeden Git yedeğine alıp güncelleyin; komutları sırayla çalıştırın ve hata alan adımda durun:

```sh
git stash push -m "pull-oncesi-yerel-yedek"
git pull --ff-only origin main
npm ci
```

Yerel değişiklikler `git stash list` içinde korunur; `.data/` içindeki hesap, talepler ve anahtarlar bu Git işlemlerine dahil değildir. Oluşturulan HTML dosyalarını eski sürüme döndürmemek için yedeği otomatik olarak `git stash pop` ile uygulamayın; gerçekten yaptığınız içerik düzenlemeleri varsa yedekten ayrıca karşılaştırılabilir. Windows'ta Git'in CRLF satır sonları ile Node'un LF çıktısının oluşturduğu tekrarlayan değişiklikler `.gitattributes` ve kaynak satır sonu normalizasyonuyla önlenir. Sayfa düzenlemelerini `scripts/build.mjs` veya `content/` kaynaklarında yapın; `public/` altındaki yedi oluşturulan HTML dosyası bir sonraki build sırasında yeniden yazılır.

## Talep akışı ve yönetim paneli

1. Ziyaretçi ad, marka, e-posta, isteğe bağlı telefon, hizmet ve proje açıklamasını girer; aydınlatma metnini okuduğunu onaylar.
2. Sunucu alanları doğrular ve talebi SQLite'a yazar; ziyaretçiye kayıt sonucu gösterilir.
3. Yönetici `/admin` üzerinden giriş yapar; talepleri arar/filtreler, detayları görüntüler ve özel not ekler.
4. Talep durumu **Yeni**, **Görüşülüyor** veya **Arşiv** olarak güncellenebilir. Yenileme düğmesi yeni talepleri getirir. Panelde Güvenlik alanından Authenticator cihazını değiştirebilir ve kurtarma kodlarını yenileyebilirsiniz; bu işlemler mevcut parola + taze ikinci faktör ister. Bu güvenlik yenilemeleri eski kurtarma setini ve diğer oturumları geçersiz kılar.

Kayıtlar varsayılan olarak **`.data/ordvis.sqlite`** dosyasındadır. **`.data/mfa.key`**, Authenticator anahtarının AES-256-GCM şifrelemesi için üretilen yerel anahtardır; veritabanı ile birlikte korunmalı ve yedeklenmelidir. Tek kullanımlık kurtarma kodlarının yalnız hashleri tutulur. Anahtar dosyası kaybolduğunda sistem yeni anahtar uydurmaz; yedekten geri yükleme gerekir. `.data/` Git'e dahil edilmez ve HTTP üzerinden sunulmaz. Kayıtlar **uygulamanın çalıştığı makinede** tutulur; GitHub veri deposu değildir. Siteyi başka makineye klonlamak talepleri veya hesabı taşımaz. Yeni barındırmada aynı site ve panelin aynı kalıcı veri dizinini kullanması gerekir.

## Asistanla talep inceleme

Panelde **Asistan özeti indir** düğmesi, yalnız tam MFA doğrulaması yapılmış yöneticiye JSON raporu verir. Önce raporu açıp gözden geçirin, sonra bu sohbete dosya olarak ekleyin. Örnek istek: “Yeni talepleri özetle, önce dönüş yapmam gerekenleri ve uygun paketleri öner, cevap taslakları hazırla.”

Rapor sayımları, paket dağılımını, yeni kayıtları ve 48 saatten eski yeni talepleri gösterir. Hesaplama deterministiktir; otomatik AI yorumu ya da satış niyeti tahmini değildir. Ad, marka, telefon, e-posta ve iç not alanları aktarılmaz; serbest metindeki belirgin iletişim bilgileri kısmen maskelenir. **Bu anonimleştirme garantisi değildir:** isimler ve başka kişisel bilgiler serbest metinde kalabilir, paylaşmadan önce kontrol edin. Talep metnindeki komutlar talimat değil güvenilmeyen veridir.

Bu sohbet paneli otomatik izlemez ve manuel rapor kendiliğinden dışarı gönderilmez. Otomatik inceleme için aşağıdaki Groq saatlik özet özelliğini kullanabilirsiniz; paneldeki paylaşım tercihi ayrı olarak açılır. Admin parolası, MFA anahtarı, çerez ve kurtarma kodlarını asistana vermeyin. Gizli bir okuma endpointi, MFA atlama yolu veya ortak yönetici hesabı oluşturulmadı.

## Groq ile saatte bir otomatik özet

Paneldeki **Otomatik özetler** bölümü müşteri adı ve genel proje açıklamasını Groq ile değerlendirir; sonuçları, ihtiyaçları ve önerilen sonraki adımı aynı panelde biriktirir. Bu, sunucuda çalışan Groq modelidir; bu sohbetin arka planda paneli izlemesi veya sohbet geçmişinizi Groq'a aktarması değildir. Model çıktıları öneridir, karar veya otomatik müşteri mesajı değildir.

1. [Groq Console](https://console.groq.com/keys) üzerinden hesabınızın API anahtarını oluşturun. Ücretsiz planın model/kota erişimi sağlayıcı koşullarına bağlıdır; sınırsız veya sürekli ücretsiz çalışma garantisi verilmez.
2. Site klasöründe `npm ci` ve **`npm run ai:setup`** çalıştırın. Mevcut yönetici adı, parola, **yeni** Authenticator/kurtarma kodu ve Groq anahtarı terminalde gizli alınır. Anahtarı sohbete veya koda yazmayın. İlk admin/MFA kurulumu önceden tamamlanmış olmalıdır.
3. Sunucuyu `npm run dev` ile yeniden başlatın. Panelde **Otomatik özetler** bölümünü açıp paylaşım tercihinin kutusunu işaretleyin ve kaydedin.
4. İlk tur etkinleştirmeden **bir saat sonra** başlar. Panel kapalı olsa da Node süreci çalışırken devam eder. Bilgisayar veya terminal kapalıysa durur; kesintisiz çalışma için kalıcı diskli bir Node sunucusu gerekir.

Varsayılan model **`llama-3.3-70b-versatile`**, sabit hedef **`https://api.groq.com/openai/v1/chat/completions`**. Yalnız `{name, brief}` müşteri verisi gönderilir; telefon/e-posta/iç not/marka/paket alanları gönderilmez. Serbest metindeki belirgin iletişim bilgileri kısmen maskelenir, kusursuz anonimleştirme değildir. Otomasyon varsayılan olarak kapalıdır ve açık paylaşım tercihi ister. Anahtar yokken ağ çağrısı yapılmaz.

- Her kayan 60 dakikada en fazla **5 API denemesi**; başarısız denemeler de sayılır. Fazla talepler sırada kalır. Başarılı özetler tekrar gönderilmez.
- Kota/servis hatalarında 60 saniye–1 saat arasında kontrollü yeniden deneme; günlük sağlayıcı kotası yine uygulanır. 20 saniyelik çağrı sınırı ve 256 KiB yanıt sınırı vardır.
- Üç geçersiz model yanıtından sonra ilgili talep otomatik sıradan ayrılır; asıl kayıt korunur ve panelde sayı gösterilir. Genel servis/kota/anahtar hataları talebi kalıcı başarısız yapmaz.
- Zamanlama, sonuçlar ve saatlik deneme kayıtları SQLite'ta kalıcıdır. Yeniden başlatmada kaçırılan her saati arka arkaya çalıştırmak yerine en fazla bir gecikmiş tur yapılır. Tek iş ve süreli veritabanı kilidi eşzamanlı tekrarları engeller.
- Özetler yalnız tam MFA oturumuna açıktır. Model metni HTML olarak çalıştırılmaz; müşteri talimatları güvenilmeyen veri olarak ele alınır, modelin araç/mesaj/komut erişimi yoktur.

`ai:setup` anahtarı `.data` veritabanında ayrı amaç etiketiyle AES-256-GCM kullanarak saklar; `.data/mfa.key` yedeği zorunludur. Hosting'in güvenli ortam değişkeni **`GROQ_API_KEY`**, kayıtlı anahtardan önceliklidir; **`GROQ_MODEL`** ile erişiminiz olan modeli seçebilirsiniz. Ortam değişkeni sağlayıcının güvenli ayarından verilmelidir; uygulama `.env` dosyasını kendiliğinden yüklemez. `HTTP_PROXY`/`HTTPS_PROXY` varsa TLS doğrulamasını koruyan proxy taşıması kullanılır; hedef `api.groq.com` ağ izinlerinde açık olmalıdır.

Bu geliştirme ortamında gerçek Groq anahtarı yoktu ve aktif ağ kuralı Groq bağlantısına 403 verdi. Groq HTTP protokolü, zamanlama ve tam panel akışı sahte sağlayıcı/anahtar ve geçici veriyle doğrulandı; canlı model üretimi doğrulanmış sayılmaz. Bulut ayarları taslağına `GROQ_API_KEY` gereksinimi ve `api.groq.com` hedefi kaydedildi; gerçek değer güvenli ayarlara veya kendi terminalinizdeki kurulum komutuna girilmeli, sonra ilgili bağlantı tekrar denenmelidir.

## Kalıcı veri ve yedekleme

- `DATA_DIR`: kalıcı veri klasörü. Varsayılan, komutun çalıştığı klasör altındaki `.data` dizinidir.
- Sunucuyu durdurup **tüm veri klasörünü** güvenli bir konuma yedekleyin. SQLite WAL kullanır; açık sunucunun yalnız `.sqlite` dosyasını kopyalamayın. Canlı yedekler için SQLite uyumlu backup aracı kullanın.
- Veritabanı kişisel bilgi içerir. Yedekleri Git'e/ortak dosyalara eklemeyin; erişimi ve saklama süresini sınırlandırın. Hosting disk şifrelemesini kullanın.
- Bu sürüm tek Node sunucusu/tek kalıcı disk içindir. Oturumlar ve genel/form hız sınırları bellektedir; giriş ve ikinci faktör limitleri SQLite üzerinde kalıcıdır; yeniden başlatma oturumları kapatır. Birden fazla sunucuya ölçeklemede ortak oturum ve limit deposu gerekir.
- Telefon kaybolursa kullanılmamış bir kurtarma koduyla giriş yapıp Güvenlik ekranından cihazınızı değiştirin. Kodları yenilemek eski seti iptal eder. Authenticator kodları kabul edildikten sonra aynı 30 saniyelik kod tekrar kullanılamaz; yeni kodu bekleyin.
- Parola/kurtarma erişimi kaybolursa veritabanını silmeyin; bu talepleri de siler. Kurtarma işlemi sunucu dosyalarına yetkili erişimle ayrı bir bakım işlemi olarak yapılmalıdır.

## Canlı yayın

HTTPS destekleyen bir Node barındırması ve **kalıcı disk** gerekir. GitHub Pages veya yalnız statik dosya barındırma bu backend'i çalıştırmaz. Örnek ortam değişkenleri (kendi alan adınız/disk yolunuzla değiştirin):

```text
NODE_ENV=production
PUBLIC_ORIGIN=https://ajansiniz.example
DATA_DIR=/kalici-disk/ordvis
```

`PUBLIC_ORIGIN` protokol + alan adı olmalıdır; sonunda `/` veya alt yol kullanmayın. Canlı ortam HTTPS origin olmadan başlamaz. Güvenlik başlıklarını koruyan reverse proxy kullanın; HTTPS PUBLIC_ORIGIN ayarlı yanıtlar HSTS içerir; proxy bu başlığı korumalıdır. `PORT` hosting sağlayıcısı tarafından atanabilir. Yönetici hesabını **yayın sunucusunda** bir kez `npm run admin:setup` ile oluşturun; geliştirme parolasını taşımayın. Salt SQLite yedeği değil tüm gerekli veri için uygun yedekleme politikası belirleyin.

Tek ve güvenilir bir reverse proxy doğrudan istemci erişimini engelliyorsa `TRUST_PROXY=1` kullanılabilir; yalnız en sağdaki `X-Forwarded-For` IP'si kabul edilir. Varsayılan olarak bu başlığa güvenilmez, bağlantı IP'si kullanılır. Vekilin tüm ziyaretçileri aynı IP'de toplaması form limitini ortaklaştırabilir; ayarı gerçek hosting yapısına göre seçin. Birden fazla proxy için ayrıca yapılandırma gerekir.

Aydınlatma metni mevcut form kullanımını açıklar. Canlıya çıkarken ajansın yasal unvanı, barındırma sağlayıcısı, saklama süresi ve varsa aktarım bilgileri gerçek işletme ve hosting bilgileriyle tamamlanmalıdır.

## Güvenlik

- Admin parolası rastgele salt ile **scrypt (N=131072, r=8, p=1)** hash olarak saklanır; eski N=32768 hesapları doğru parola doğrulandığında veri kaybı olmadan yükseltilir; düz metin tutulmaz.
- Oturumlar kriptografik rastgele token, **HttpOnly / SameSite=Strict** çerez kullanır. HTTPS için **Secure ve `__Host-` öneki** uygulanır. Tam oturum 4 saat, boşta kalma 15 dakika; MFA kurulum oturumu en fazla 10 dakikadır. Panel de 15 dakika sonunda ekrandaki verileri temizler. Parola/MFA/kurtarma değişiklikleri kalıcı hesap sürümü ile tüm eski oturumları iptal eder.
- Yazma istekleri aynı kaynak doğrulaması ve JSON içerik türü gerektirir. Yönetici değişiklikleri ayrıca oturuma bağlı CSRF token ile korunur.
- RFC 6238 TOTP (SHA-1, 6 hane, 30 saniye, ±1 adım), veritabanında atomik tekrar engeli ve tek kullanımlık kurtarma kodları uygulanır. Authenticator anahtarı AES-256-GCM ile şifrelenir; bu koruma yalnız veritabanı kopyasının ele geçirilmesine karşıdır. Sunucunun/anahtar dosyasının ele geçirilmesine karşı garanti değildir. Kişisel talep verileri SQLite içinde düz tutulur; disk şifrelemesi ve sınırlı sunucu erişimi gerekir.
- Parametreli SQL, sunucu tarafı alan uzunluğu/biçim doğrulaması, 16 KiB gövde sınırı, honeypot ve IP bazlı hız sınırları uygulanır. Genel sınır 120 istek/dakika, form sınırı 5 kabul/10 dakika; giriş sınırı 5 deneme/15 dakikadır. Başarılı giriş deneme sayısını sıfırlar. İkinci faktör için doğru parola sonrasında IP’ler arasında ortak 10 deneme/15 dakika limiti uygulanır; başarı sıfırlar. En fazla 2 eşzamanlı scrypt işi kabul edilir. Giriş ve ikinci faktör limitleri servis yeniden başlatılarak aşılamaz. Sınırlı güvenlik olay kaydı, parola/kod/talep içeriği olmadan en fazla 30 gün ve 1000 kayıt saklanır.
- Tekrar denemeler aynı `requestId` ile aynı kayda gider; çift kayıt oluşturmaz.
- Admin arayüzü kullanıcı içeriğini yalnız metin olarak gösterir; HTML çalıştırmaz. Şifre veya oturum token'ı localStorage'a yazılmaz.
- Geliştirme sunucusu varsayılan olarak yalnız `127.0.0.1` üzerinde dinler; üretimde `0.0.0.0`, gerektiğinde `HOST` açıkça ayarlanabilir. Çapraz site Fetch Metadata istekleri reddedilir; proxy başlığına varsayılan güvenilmez.
- Sıkı CSP, frame engelleme, MIME koklama engelleme ve no-store özel veri yanıtları. Yalnız genel dosyalar açık izin listesiyle sunulur.

Bu kontroller bir penetrasyon testi veya mutlak güvenlik garantisi değildir. İleride ödeme, dosya yükleme, ek kullanıcı rolleri ya da dış entegrasyon eklenirse bu yüzeyler ayrıca ele alınmalıdır.

## Sayfalar ve içerik

`/`, `/produksiyon`, `/drone`, `/kurgu`, `/dijital`, `/paketler`, `/iletisim` ve özel giriş sayfası `/admin`.

- `scripts/build.mjs`: ortak sayfa şablonları; `content/` fiyat ve form kaynakları.
- `public/*.html`: oluşturulan sayfalar. Şablon değişikliklerinde `npm run build` çalıştırın.
- `public/style.css`, `public/app.js`: public site. `public/admin.*`: ayrı yönetim arayüzü.
- `lib/store.mjs`, `lib/api.mjs`, `server.mjs`: kalıcı kayıt, yetki ve HTTP katmanı.
- `scripts/admin-setup.mjs`: maskeli terminal hesabı kurulumu.
- `scripts/ai-setup.mjs`, `lib/ai-summary.mjs`, `lib/automation.mjs`: Groq anahtarı, kısıtlı istemci ve kalıcı saatlik iş.
- `lib/provider-fetch.mjs`: doğrulamalı proxy taşıması; anahtar tarayıcıya verilmez.

Konsept SVG'ler müşteri referansı veya gerçek çekim olarak sunulmaz. Kurgu alanı ses/video oynatmayan görsel demodur. Drone kontrol düğmeleri kaldırıldı; giriş ve süzülme animasyonu devam eder. Hareket azaltma tercihi desteklenir. PDF fiyatları 30 Kasım 2026 tarihine kadar geçerlidir; motion/VFX özel kapsamı ayrıca teklif edilir.

İletişim: **ordviscreative@gmail.com**, **+90 530 716 88 08**.

## Doğrulama

```sh
npm run build
npm run check
npm test
```

Güvenlik, veri, rapor, Groq protokolü ve saatlik otomasyon test grupları; kalıcı kayıt/yeniden başlatma, scrypt, oturum ve çıkış, Origin/CSRF, doğrulama, gövde sınırı, HTTPS çerezi, eşzamanlı giriş sınırı, tekrar gönderim, özel veri/dosya erişimi, sayfalar ve CLI başlangıcını kapsar. Ek testler RFC TOTP vektörlerini, kalıcı tekrar engelini, MFA öncesi yetki kısıtını, kurtarma tüketimini, cihaz değişimini, hesap sürümü ve yavaş istek iptalini, kalıcı IP/hesap limitlerini, anahtar kaybında kapalı kalmayı ve rapor mahremiyetini doğrular.

Chromium ile 320/390/768/1440 px tüm sayfalar ve panel; gerçek form > veritabanı > giriş > talep detayları > durum/not kaydı > sayfa yenileme > çıkış akışı doğrulandı. Zararlı HTML örnekleri metin olarak kaldı. Maskeli yönetici kurulum komutu, yanlış eski parolayla değişiklik reddi ve hesap değiştirme ayrıca geçici veride denendi. Gerçek tarayıcıda MFA → otomasyon izni → ileri alınmış saat → sahte Groq HTTP yanıtı → SQLite özet → sayfa yenileme → kapatma/çıkış akışı ve anahtarın maskeli kurulumu doğrulandı. Gerçek tarayıcıda ilk MFA kurulumu, kurtarma koduyla giriş, kod yenileme, cihaz değiştirme ve kontrollü asistan raporu indirme de doğrulandı. Kontroller Linux üzerinde yürütüldü; Windows üzerinde doğrudan koşulmadı.
