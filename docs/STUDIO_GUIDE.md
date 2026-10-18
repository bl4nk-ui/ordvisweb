# Ordvis stüdyo kullanım rehberi

## Önce güncelleme ve veri

Sunucuyu durdurup tüm `DATA_DIR` klasörünü (varsayılan `.data`) güvenli bir yere yedekleyin. Veritabanı, `mfa.key` ve `studio-media/` birlikte korunmalıdır. Sonra proje klasöründe `git pull --ff-only origin main`, `npm ci`, `npm run dev` çalıştırın. Mevcut ana yönetici hesabını yeniden oluşturmayın. Veritabanı geçişleri mevcut kayıtları korur.

Portfolyo, müşteri dosyaları ve yönetim kayıtları çalışan sunucunun kalıcı diskindedir; GitHub'a gönderilmez. İnternetten müşteri erişimi için HTTPS ve kalıcı diskli bir Node sunucusu gerekir. Yerel bilgisayardaki bağlantılar yalnız o bilgisayarda kullanılabilir.

## Ortak hesapları ve şifreyi göster

Ana yönetici panelde **Ekip** bölümünden her ortağa ayrı kullanıcı adı, görünen ad ve geçici şifre tanımlar. Arayüz yeni şifrelerde en az 16 karakter ister. Şifre, Authenticator anahtarı ve kurtarma kodlarını sohbete veya Git'e eklemeyin.

Ortak ilk girişte geçici şifresini değiştirir; ardından kendi telefonunda Google Authenticator, Microsoft Authenticator veya TOTP destekli uygulamayı kurar. Bu işlemler tamamlanana kadar proje verilerine erişemez. Herkesin doğrulaması ve kurtarma kodları ayrıdır; ana yönetici kendi hesabıyla bütün işleri yönetmek için ortaklarının kodlarını istemez. Ekrandaki **Göster/Gizle** düğmesi şifreyi görünür yapabilir; çıkışta alanlar temizlenir ve yeniden gizlenir.

Ana yönetici bir ortak hesabını kapatabilir veya geçici şifre tanımlayabilir. İlgili hesabın mevcut oturumları iptal edilir. Şifre sıfırlaması mevcut Authenticator eşleşmesini kaldırmaz. Kullanıcı yönetimi, global Groq ayarı, asistan dışa aktarımı, işlem geçmişi ve kalıcı silme ana yöneticiye aittir. Ortaklar normal proje, teslim, teklif, portfolyo ve referans işlerini yönetebilir. **Bana atananlar** çalışma filtresidir; diğer projeleri gizleyen bir yetki sınırı değildir.

## Projeyi hazırlama

1. Talebi açın; **Sorumlu, kapsam ve revizyon şartları** alanından ekip üyesi, kapsam, teslim edilecekler ve hedef tarihi kaydedin.
2. İş takibinden aşamayı, sonraki görüşmeyi, anlaşılan ana tutarı, toplam alınan ödemeyi ve vadeyi kaydedin. Kayıtlı kapsam ve teslimler müşteri görünümüne yansır; iç notlar yansımaz.
3. Talep listesi veya iş kartındaki **Teslim et** düğmesi ilgili projenin teslim bölümünü açar. Sorumlu atamak ve **Bana atananlar** filtresi günlük takibi kolaylaştırır.

## Teklif ve PDF

Talepteki **Teklifler ve PDF** alanından hizmet açıklaması, adet, birim fiyat, kapsam, teslimler, tarih ve şartlarla taslak oluşturun. Tutarları TL olarak virgül veya noktayla, binlik ayıracı olmadan girin. Sunucu toplamı tam sayı kuruşla hesaplar.

**PDF** gerçek, logolu ve Türkçe karakterli dosya indirir. Teklifi müşteriye kendiniz iletin. Müşterinin kabulünü panelde kaydetmek ana anlaşma tutarını ve kapsamı projeye bağlar; tahsilat oluşturmaz. Bu işlem elektronik imza değildir. Paylaşılan teklifin içeriği, kabul edilen teklifin de durumu değiştirilemez; içerik değişikliği için yeni taslak oluşturun. Aynı projeye ikinci bir kabul edilmiş teklif bağlanamaz.

## Müşteriye teslim

1. İlgili projede teslim başlığı, açıklama ve erişim süresiyle teslim oluşturun. Sistem sipariş numarası, özel erişim kodu ve tek tıklamalı özel bağlantı verir. Kod ve bağlantı sırrı yalnız oluşturulduğunda gösterilir; kopyalayıp müşteriye kendiniz iletin.
2. JPG/PNG/WebP görselleri en fazla 8 MiB; MP4/WebM video veya PDF en fazla 100 MiB yükleyin. Teslim başına en fazla 20 dosya vardır. Dosyalar dönüştürülmez veya sıkıştırılmaz; tarayıcıda oynatılabilen video biçimi kullanın.
3. **Müşteri görünümü** ile dosyaları ve kapsamı kontrol edin. Önizleme yöneticinin kendi oturumuna bağlıdır; müşteriye ait bir onay veya revizyon işlemi yapmaz.
4. Müşteri sitedeki **Projemi görüntüle** bölümünde sipariş numarası ve özel erişim kodunu girer veya özel bağlantıyı açar. E-posta doğrulaması ve müşteri hesabı oluşturma gerekmez. Sipariş numarası tek başına dosyalara erişim vermez.
5. Müşteri dosyaları görüntüler/indirir, revizyon turu gönderir veya dosyaları incelediğini onaylar. Onay işi otomatik tamamlamaz; ödemeyi kontrol edip tamamlananlar klasörüne alma işlemi stüdyodadır.

Yeni teslim bağlantısı oluşturmak önceki bağlantı ve erişim kodunu kapatır; sipariş numarası ve proje revizyon sayacı korunur. Süre dolması, iptal ve çöp kutusuna taşıma erişimi kapatır. Dosya eklemek veya kaldırmak yeni sürüm oluşturur; önceki sürümün onayını ve medya oturumlarını geçersiz kılar. Daha önce indirilen dosyalar geri alınamaz.

## Kesin revizyon kuralı

**Proje başına 3 revizyon turu dahildir. Sonraki her tur 1.000 TL'dir.** Bu kural bağlantı veya dosya sürümü yenilendiğinde sıfırlanmaz.

Müşteri videoyu durdurup bulunduğu saniyeye not ekleyebilir; notlarını düzenleyip birden fazla notu tek turda birlikte gönderir. Genel açıklama da eklenebilir. Tek tek notlar ayrı revizyon hakkı tüketmez. Bir tur gönderildikten sonra yeni dosya sürümü gelene kadar yeni tur gönderilemez.

Dördüncü ve sonraki turlarda 1.000 TL tutarı açıkça görünür ve müşteri ek ücreti onaylamadan tur kaydedilmez. Aynı gönderimin tekrar denenmesi ikinci hak veya ücret oluşturmaz. Ek ücretler ayrı revizyon kayıtlarında tutulur ve kayıtlı ana anlaşma tutarıyla birlikte kalan hesaplamasına girer; **otomatik para çekilmez veya ödeme alınmış sayılmaz**. Tahsil edilen toplamı yönetici ayrıca kaydeder.

Güncelleme öncesindeki revizyon kayıtları proje hakkı hesabında korunur; geçmiş turlara geriye dönük ücret eklenmez. Kapsam dışı yeni iş veya yeni proje için ayrıca anlaşın; mevcut revizyon ücretini arayüzden değiştiren alan yoktur.

## Portfolyo, müşteri logoları ve yorumlar

Menüde **Portfolyo** kullanılır. Genel sayfa `/portfolyo`, proje sayfası `/portfolyo/proje-adresi` şeklindedir; eski `/isler` bağlantıları yönlendirilir. Portfolyo panelinde projeyi taslak/yayın olarak yönetin, **Öne çıkan** ve sıra alanlarıyla ana sayfadaki projeleri seçin. Küçük sıra değeri önce gelir.

**Müşteriler** alanında gerçek marka adı, açıklama ve yerel logo dosyası ekleyin. Yayınlamadan önce adı/logo kullanma iznini doğrulayan kutuyu işaretleyin. Dış adresten dosya indirilmez; SVG kabul edilmez. Yayınlanmış müşteri yoksa ana sayfa bu bölümü göstermez.

Teslimi onaylayan müşteri, görünmesini istediği ad/şirket, puan ve yorumunu açık yayın izniyle bırakabilir. Yorum önce beklemeye düşer. **Yorumlar** bölümünde kontrol edip onayladığınız kayıtlar yayına çıkar; reddedebilir veya yayından kaldırabilirsiniz. Gerçek müşteri, logo veya yorum örneği otomatik eklenmez.

## Çöp kutusu ve işlem geçmişi

Talep, portfolyo projesi ve proje/teslim dosyalarının normal kaldırma işlemi **30 günlük çöp kutusuna** taşır. Dosyalar bu sürede diskte tutulur; genel ve müşteri erişimi kapanır. Çöp kutusundan geri yükleme yapabilirsiniz. Projenin kendisi çöp kutusundaysa önce onu geri yükleyin. Aynı kapak alanına yeni dosya eklenmişse eski kapağı geri getirmeden önce çakışmayı giderin.

Talebi geri yüklemek eski teslim bağlantılarını açmaz; gerektiğinde yeni teslim erişimi oluşturun. Ana yönetici açık **SİL** onayıyla kalıcı temizleme yapabilir. Süresi dolan kayıtlar sunucu çalışırken yapılan sınırlı temizlikle kalıcı kaldırılır; yedekler ayrı saklama politikasına tabidir.

**İşlem geçmişi**, kimin hangi kayıt üzerinde işlem yaptığını gösterir. Şifre, erişim kodu, dosya içeriği ve müşteri açıklamaları günlük metnine yazılmaz. Kayıtlar sınırlı sayıda tutulur; muhasebe veya değişmez adli kayıt sistemi değildir.

## Lisans ve çalışma sınırları

PDF üretimi `pdf-lib` ve `@pdf-lib/fontkit` ile sunucuda yapılır; API anahtarı veya harici PDF hizmeti gerekmez. Türkçe karakterler için paketlenmiş DejaVu Sans kullanılır; lisansı `assets/fonts/LICENSE-DejaVu.txt` içindedir. Yazı tipi ve sunucu kaynakları HTTP üzerinden sunulmaz.

Sipariş/erişim kodlarını bilen kişiler projeye ulaşabilir; bu sistem müşteri kimlik doğrulaması veya çevrimiçi ödeme altyapısı değildir. Dosyalar yalnız MFA doğrulanmış ekip tarafından yüklenir. Tek Node sunucusu ve tek kalıcı disk hedeflenir; hosting kotası, HTTPS ve güvenli veri yedeği işletilmelidir.
