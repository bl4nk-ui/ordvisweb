# Ordvis Creative

Türkçe, yedi sayfalı kreatif ajans sitesi. Koyu editoryal tasarım; sinematik konsept illüstrasyonları, drone giriş animasyonu ve etkileşimli kurgu/renk/efekt alanı. Harici çalışma zamanı bağımlılığı, çerez veya izleyici kullanılmaz.

## Bilgisayarında çalıştırma

Node.js **22 veya üzeri** kurulu olmalı (Node 24 ile doğrulandı). VS Code ile klonlanmış depoda terminali açın:

```sh
git pull origin main
npm ci
npm run dev
```

`Ordvis Creative listening on 3000` mesajı gelince aynı bilgisayarda `http://127.0.0.1:3000` açın. Terminali açık tutun. Durdurmak için Ctrl+C. `npm run dev` ve `npm start`, sayfaları otomatik oluşturur.

Port kullanılıyorsa PowerShell'de `$env:PORT=3001; npm run dev`, Bash'te `PORT=3001 npm run dev` çalıştırın ve 3001 portunu açın. Windows başlangıç yolu kontrolü dosya URL'sine dönüştürülür; boşluk ve Türkçe karakter içeren yollar desteklenir. Bu ortamda başlangıç Linux üzerinde doğrulandı; Windows makinesinde ayrıca çalıştırılmadı.

## Sayfalar

| Yol | İçerik |
| --- | --- |
| `/` | Görsel ana sayfa ve uzmanlık alanları |
| `/produksiyon` | Film, marka, mekân ve sosyal içerik üretimi |
| `/drone` | Yukarıdan gelen drone, tekrar oynatma ve hareket duraklatma |
| `/kurgu` | Ham/renk/efekt geçişi ve 12 saniyelik zaman çizelgesi |
| `/dijital` | Web, sosyal medya, Meta ve Google reklam yönetimi |
| `/paketler` | Katalogdaki fiyatlar, karşılaştırma ve SSS |
| `/iletisim` | Telefon, e-posta ve WhatsApp proje mesajı |

Drone görseli ve manzaralar orijinal SVG konsept illüstrasyonlarıdır; gerçek çekim veya müşteri referansı olarak sunulmaz. Gerçek ajans çekimleri geldiğinde konsept görsellerin yerini alabilir. Kurgu alanı etkileşimli bir görsel demodur, ses/video oynatmaz. Motion/VFX özel kapsamı ayrıca teklif edilir; PDF'deki paketlere yeni bir teslimat taahhüdü eklenmemiştir.

## Düzenleme

- `scripts/build.mjs`: ortak başlık/altbilgi ve sayfa şablonları.
- `content/paketler.html`: katalog kapsamı, fiyatlar ve koşullar.
- `content/iletisim.html`: iletişim formu ve metinler.
- `public/style.css`, `public/app.js`: responsive tasarım ve etkileşimler.
- `public/media/`: yerel konsept görselleri.
- `public/*.html`: oluşturulan, Git'e dahil edilen sayfalar; doğrudan düzenlemek yerine kaynak şablonlarını değiştirin.

Şablon değişikliğinden sonra `npm run build` çalıştırın. `npm run dev` başlamadan önce de otomatik çalışır. Açık sunucuda HTML kaynak değişiklikleri için yeniden build yapıp tarayıcıyı yenileyin. Derleme bağımlılığı yoktur; yalnız Node.js kullanılır.

İletişim: **ordviscreative@gmail.com**, **+90 530 716 88 08**. Paket bağlantısı, seçimi `/iletisim?paket=…` üzerinden taşır. Form, URL-kodlanmış mesajı WhatsApp'ta açar; kullanıcı göndermeden mesaj ajansa ulaşmaz. Sunucu form verisini almaz/saklamaz. PDF fiyatları 30 Kasım 2026 tarihine kadar geçerlidir.

## Kontroller

```sh
npm run build
npm run check
npm test
```

HTTP testleri yedi sayfanın doğrudan ve sorgu parametreleriyle açılmasını, farklı başlıklarını, HEAD yanıtlarını, slash yönlendirmelerini, varlık türlerini, güvenlik başlıklarını, özel dosya engellerini ve CLI başlangıcını kontrol eder.

Chromium'da 320/390/768/1440 px ekranlarda tüm sayfalarda taşma ve eksik görsel kontrolü; mobil menü ve Escape, drone giriş/tekrar oynatma/hareket azaltma, kurgu aşamaları, zaman çizelgesi oynat/duraklat/sona ulaşma, paket seçimi, karşılaştırma, WhatsApp mesajı ve gizlilik penceresi doğrulandı. WhatsApp testi dış yönlendirmeyi yakalar; gerçek mesaj göndermez.

## Güvenlik ve yayın

Sunucu yalnız açık izin listesindeki sayfa ve varlıkları sunar; GET/HEAD dışındaki yöntemleri reddeder. Sıkı CSP, frame engelleme, MIME koklama engelleme, referrer ve izin politikası uygulanır. Kullanıcı girdisi HTML'e basılmaz. Üçüncü taraf animasyon kütüphanesi, hesap, veritabanı veya yönetim paneli yoktur. Katalogdaki panel ifadeleri müşterilere sunulan hizmetin kapsamıdır.

Canlı yayında HTTPS sağlayan bir reverse proxy/barındırma kullanın. Güvenlik başlıkları korunmalıdır. HSTS yalnız HTTPS alan adı doğrulandıktan sonra proxy'de etkinleştirilmelidir. Yeni ortamda sunucu süreci yeniden başlatılır; `PORT` barındırma sağlayıcısınca atanabilir. İleride form API'si/panel eklenirse kimlik doğrulama, oran sınırlama, sunucu tarafı doğrulama, CSRF ve KVKK ayrıntıları ayrıca ele alınmalıdır. Bu doğrulamalar bir penetrasyon testi veya mutlak güvenlik garantisi değildir.
