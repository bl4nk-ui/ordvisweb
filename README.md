# Ordvis Creative

Türkçe, mobil uyumlu ajans sitesi. Tasarım ve hizmet kapsamı Ekim 2026 kataloğuna dayanır. Harici çalışma zamanı bağımlılığı, izleyici ve çerez kullanılmaz.

## Çalıştırma

Node.js 22 veya üzeri (Node 24 ile doğrulandı).

```sh
cd /workspace/ordvisweb
npm ci --ignore-scripts
npm run check
npm test
npm run dev
```

Sunucu varsayılan olarak 3000 portunda çalışır; `PORT` ile değiştirilebilir. Ayrı derleme adımı yoktur. `public/` içeriği doğrudan sunulur. Sunucu sürecinin yeni görevlerde yeniden başlatılması gerekir.

## İçerik

- `public/index.html`: hizmetler, fiyatlar, kapsam ve SSS
- `public/style.css`: responsive tasarım ve hareket azaltma desteği
- `public/app.js`: menü, paket seçimi, WhatsApp proje mesajı ve gizlilik penceresi
- `public/ordvis-katalog-2026.pdf`: kullanıcı tarafından sağlanan orijinal katalog
- `server.mjs`: genel dosya izin listesi ve güvenlik başlıkları

İletişim: ordviscreative@gmail.com, +90 530 716 88 08. Form, proje bilgilerini URL-kodlaması ile WhatsApp mesaj taslağına aktarır; ziyaretçi göndermeden mesaj ajansa ulaşmaz. Site form verisini saklamaz. Telefon ve e-posta bağlantıları da sunulur. PDF fiyatları 30 Kasım 2026 tarihine kadar geçerlidir.

## Güvenlik ve yayın

Sunucu yalnız GET/HEAD kabul eder; açık dosya listesi dışındaki yollar 404 döner. CSP, frame engelleme, MIME koklama engelleme ve izin politikası uygulanır. Kullanıcı girdisi DOM'a HTML olarak basılmaz. Sunucu form verisi almaz veya saklamaz. Uygulamada hesap, yönetim paneli veya veri tabanı yoktur; katalogdaki panel ifadeleri müşterilere sunulan hizmetin kapsamıdır.

Canlı yayında HTTPS sağlayan bir reverse proxy/barındırma kullanın. HSTS'yi yalnız HTTPS alan adı doğrulandıktan sonra proxy üzerinde etkinleştirin. Proxy güvenlik başlıklarını korumalıdır. İleride form API'si veya yönetim paneli eklenirse kimlik doğrulama, oran sınırlama, sunucu tarafı doğrulama, CSRF ve KVKK bilgilendirmesi ayrıca tasarlanmalıdır. Bu kurulum bir penetrasyon testi veya mutlak güvenlik garantisi değildir.

## Doğrulama

`npm test` gerçek HTTP sunucusunda içerik sunumu, PDF, güvenlik başlıkları, özel dosya engelleme, HEAD ve POST reddini kontrol eder. Chromium ile 390/768/1440 px taşma kontrolü; mobil menü, paket seçimi, WhatsApp mesaj taslağı, karşılaştırma ve gizlilik penceresi doğrulandı. Tarayıcı kontrol araçları yalnız geçici test klasörüne kuruldu; uygulama bağımlılığı değildir.
