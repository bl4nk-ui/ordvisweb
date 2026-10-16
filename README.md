# Ordvis Creative

Yedi sayfalı ajans sitesi ve özel **stüdyo yönetim paneli**. Teklif formu bilgileri aynı sunucudaki SQLite veritabanına kaydeder; WhatsApp'a yönlendirme yapmaz. Harici çalışma zamanı bağımlılığı yoktur. Node.js **22.13 veya üzeri**, tercihen güncel Node.js LTS gereklidir (Node 24 ile doğrulandı).

## Kendi bilgisayarında başlatma

VS Code terminalinde `package.json` bulunan **ordvisweb** klasöründe çalıştırın:

```sh
git pull origin main
npm ci
npm run admin:setup
npm run dev
```

`admin:setup` size bir kullanıcı adı ve en az **12 karakterli parola** sorar. Parola yazarken karakterler yıldızla görünür. Hazır veya varsayılan bir yönetici parolası yoktur; parolayı chat'e, koda veya Git'e yazmayın. Kurulum mevcut hesabı değiştirecekse önce mevcut parolayı doğrular. Kurulum sonrasında çalışan sunucuyu yeniden başlatın.

Terminal `Ordvis Creative listening on 3000` yazınca aynı bilgisayarda:

- Site: `http://127.0.0.1:3000`
- Panel: `http://127.0.0.1:3000/admin`

Terminali açık bırakın; durdurmak için Ctrl+C. `npm run dev` ve `npm start` sayfaları otomatik oluşturur. Güncelleme için sunucuyu durdurun, `git pull origin main`, `npm ci`, `npm run dev` çalıştırın. Mevcut hesabı yeniden kurmanız gerekmez. Port doluysa PowerShell'de `$env:PORT=3001; npm run dev`, Bash'te `PORT=3001 npm run dev` kullanın.

## Talep akışı ve yönetim paneli

1. Ziyaretçi ad, marka, e-posta, isteğe bağlı telefon, hizmet ve proje açıklamasını girer; aydınlatma metnini okuduğunu onaylar.
2. Sunucu alanları doğrular ve talebi SQLite'a yazar; ziyaretçiye kayıt sonucu gösterilir.
3. Yönetici `/admin` üzerinden giriş yapar; talepleri arar/filtreler, detayları görüntüler ve özel not ekler.
4. Talep durumu **Yeni**, **Görüşülüyor** veya **Arşiv** olarak güncellenebilir. Yenileme düğmesi yeni talepleri getirir.

Kayıtlar varsayılan olarak **`.data/ordvis.sqlite`** dosyasındadır. `.data/` Git'e dahil edilmez ve HTTP üzerinden sunulmaz. Kayıtlar **uygulamanın çalıştığı makinede** tutulur; GitHub veri deposu değildir. Siteyi başka makineye klonlamak talepleri veya hesabı taşımaz. Yeni barındırmada aynı site ve panelin aynı kalıcı veri dizinini kullanması gerekir.

## Kalıcı veri ve yedekleme

- `DATA_DIR`: kalıcı veri klasörü. Varsayılan, komutun çalıştığı klasör altındaki `.data` dizinidir.
- Sunucuyu durdurup **tüm veri klasörünü** güvenli bir konuma yedekleyin. SQLite WAL kullanır; açık sunucunun yalnız `.sqlite` dosyasını kopyalamayın. Canlı yedekler için SQLite uyumlu backup aracı kullanın.
- Veritabanı kişisel bilgi içerir. Yedekleri Git'e/ortak dosyalara eklemeyin; erişimi ve saklama süresini sınırlandırın. Hosting disk şifrelemesini kullanın.
- Bu sürüm tek Node sunucusu/tek kalıcı disk içindir. Oturumlar ve hız sınırları bellektedir; yeniden başlatma oturumları kapatır. Birden fazla sunucuya ölçeklemede ortak oturum ve limit deposu gerekir.
- Parola kaybolursa veritabanını silmeyin; bu talepleri de siler. Kurtarma işlemi sunucu dosyalarına yetkili erişimle ayrı bir bakım işlemi olarak yapılmalıdır.

## Canlı yayın

HTTPS destekleyen bir Node barındırması ve **kalıcı disk** gerekir. GitHub Pages veya yalnız statik dosya barındırma bu backend'i çalıştırmaz. Örnek ortam değişkenleri (kendi alan adınız/disk yolunuzla değiştirin):

```text
NODE_ENV=production
PUBLIC_ORIGIN=https://ajansiniz.example
DATA_DIR=/kalici-disk/ordvis
```

`PUBLIC_ORIGIN` protokol + alan adı olmalıdır; sonunda `/` veya alt yol kullanmayın. Canlı ortam HTTPS origin olmadan başlamaz. Güvenlik başlıklarını koruyan reverse proxy kullanın; HSTS'yi HTTPS doğrulandıktan sonra proxy'de etkinleştirin. `PORT` hosting sağlayıcısı tarafından atanabilir. Yönetici hesabını **yayın sunucusunda** bir kez `npm run admin:setup` ile oluşturun; geliştirme parolasını taşımayın. Salt SQLite yedeği değil tüm gerekli veri için uygun yedekleme politikası belirleyin.

Tek ve güvenilir bir reverse proxy doğrudan istemci erişimini engelliyorsa `TRUST_PROXY=1` kullanılabilir; yalnız en sağdaki `X-Forwarded-For` IP'si kabul edilir. Varsayılan olarak bu başlığa güvenilmez, bağlantı IP'si kullanılır. Vekilin tüm ziyaretçileri aynı IP'de toplaması form limitini ortaklaştırabilir; ayarı gerçek hosting yapısına göre seçin. Birden fazla proxy için ayrıca yapılandırma gerekir.

Aydınlatma metni mevcut form kullanımını açıklar. Canlıya çıkarken ajansın yasal unvanı, barındırma sağlayıcısı, saklama süresi ve varsa aktarım bilgileri gerçek işletme ve hosting bilgileriyle tamamlanmalıdır.

## Güvenlik

- Admin parolası rastgele salt ile **scrypt** hash olarak saklanır; düz metin tutulmaz.
- Oturumlar kriptografik rastgele token, **HttpOnly / SameSite=Strict** çerez kullanır. HTTPS origin için **Secure** eklenir. Mutlak süre 8 saat, boşta kalma süresi 30 dakikadır; çıkış token'ı iptal eder.
- Yazma istekleri aynı kaynak doğrulaması ve JSON içerik türü gerektirir. Yönetici değişiklikleri ayrıca oturuma bağlı CSRF token ile korunur.
- Parametreli SQL, sunucu tarafı alan uzunluğu/biçim doğrulaması, 16 KiB gövde sınırı, honeypot ve IP bazlı hız sınırları uygulanır. Genel sınır 120 istek/dakika, form sınırı 5 kabul/10 dakika; giriş sınırı 5 deneme/15 dakikadır. Başarılı giriş deneme sayısını sıfırlar.
- Tekrar denemeler aynı `requestId` ile aynı kayda gider; çift kayıt oluşturmaz.
- Admin arayüzü kullanıcı içeriğini yalnız metin olarak gösterir; HTML çalıştırmaz. Şifre veya oturum token'ı localStorage'a yazılmaz.
- Sıkı CSP, frame engelleme, MIME koklama engelleme ve no-store özel veri yanıtları. Yalnız genel dosyalar açık izin listesiyle sunulur.

Bu kontroller bir penetrasyon testi veya mutlak güvenlik garantisi değildir. İleride ödeme, dosya yükleme, ek kullanıcı rolleri ya da dış entegrasyon eklenirse bu yüzeyler ayrıca ele alınmalıdır.

## Sayfalar ve içerik

`/`, `/produksiyon`, `/drone`, `/kurgu`, `/dijital`, `/paketler`, `/iletisim` ve özel giriş sayfası `/admin`.

- `scripts/build.mjs`: ortak sayfa şablonları; `content/` fiyat ve form kaynakları.
- `public/*.html`: oluşturulan sayfalar. Şablon değişikliklerinde `npm run build` çalıştırın.
- `public/style.css`, `public/app.js`: public site. `public/admin.*`: ayrı yönetim arayüzü.
- `lib/store.mjs`, `lib/api.mjs`, `server.mjs`: kalıcı kayıt, yetki ve HTTP katmanı.
- `scripts/admin-setup.mjs`: maskeli terminal hesabı kurulumu.

Konsept SVG'ler müşteri referansı veya gerçek çekim olarak sunulmaz. Kurgu alanı ses/video oynatmayan görsel demodur. Drone kontrol düğmeleri kaldırıldı; giriş ve süzülme animasyonu devam eder. Hareket azaltma tercihi desteklenir. PDF fiyatları 30 Kasım 2026 tarihine kadar geçerlidir; motion/VFX özel kapsamı ayrıca teklif edilir.

İletişim: **ordviscreative@gmail.com**, **+90 530 716 88 08**.

## Doğrulama

```sh
npm run build
npm run check
npm test
```

16 test grubu; kalıcı kayıt/yeniden başlatma, scrypt, oturum ve çıkış, Origin/CSRF, doğrulama, gövde sınırı, HTTPS çerezi, eşzamanlı giriş sınırı, tekrar gönderim, özel veri/dosya erişimi, sayfalar ve CLI başlangıcını kapsar.

Chromium ile 320/390/768/1440 px tüm sayfalar ve panel; gerçek form > veritabanı > giriş > talep detayları > durum/not kaydı > sayfa yenileme > çıkış akışı doğrulandı. Zararlı HTML örnekleri metin olarak kaldı. Maskeli yönetici kurulum komutu, yanlış eski parolayla değişiklik reddi ve hesap değiştirme ayrıca geçici veride denendi. Kontroller Linux üzerinde yürütüldü; Windows üzerinde doğrudan koşulmadı.
