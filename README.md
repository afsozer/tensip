<p align="center"><img src="uygulama/tensip.iconset/icon_256x256.png" width="128" alt="Tensip"></p>

# Tensip

Tensip, UYAP Avukat Portalı'ndaki dava dosyalarınızı kendi bilgisayarınızda düzenli bir arşive indiren, bu arşivi portalla eşitleyen ve evrakları masaüstünde okunur hâlde gösteren açık kaynaklı bir yardımcı uygulamadır. Bir avukat tarafından kendi bürosunda kullanmak için yazıldı ve macOS üzerinde günlük işte kullanılıyor.

> **Tensip resmî bir uygulama değildir.** Adalet Bakanlığı, UYAP ya da herhangi bir baro ile bağlantısı yoktur; onlar tarafından geliştirilmemiş, onaylanmamış ve desteklenmemektedir. "UYAP" adı yalnızca uygulamanın birlikte çalıştığı sistemi tarif etmek için geçer.

## Ne yapar

- **Dosya listesi:** Vekili olduğunuz hukuk, ceza ve icra dosyalarını mahkeme, yıl ve sıra girmeden listeler. Türkçe karakterleri doğru eşleyen yerel arama, durum filtresi ve sıralama sunar.
- **Arşiv ve eşitleme:** Seçtiğiniz dosyanın evraklarını yerel bir klasöre indirir. Sonraki eşitlemelerde yalnızca yeni ya da değişmiş evrakları getirir. Ek evraklar ana evrakın altında gruplanır, yeni ve güncellenen evraklar işaretlenir.
- **Önizleme:** UDF ve metin katmanlı PDF belgelerini yerelde metne çevirir. Böylece evrakı açmadan okuyabilir, arşivde arama yapabilirsiniz.
- **Dosya ayrıntısı:** Safahat, taraflar ve hesap bilgisini dosya ekranında gösterir.
- **Ajanda:** Yaklaşan duruşma ve keşifleri güne göre gruplar ve istediğinizi `.ics` olarak macOS Takvim'e aktarır.
- **Denetim ve onarım:** Arşivdeki eksik, bozuk ya da mükerrer kayıtları bulur ve hangi kaydın neden sorunlu olduğunu açıklar. Yalnızca güvenle düzeltebileceği kayıtları onarır.
- **Üç arayüz:** Bir macOS uygulama penceresi, tarayıcıdan açılan yerel bir pano (`http://127.0.0.1:4747`) ve betiklerde kullanılabilen, JSON çıktı veren bir komut satırı (`tensip`).

## Ne yapmaz

Tensip UYAP'a evrak, dilekçe ya da başka bir içerik göndermez ve sizin adınıza imza atmaz. Portalda yalnızca okuma yapar: sorgular ve belge indirir. Arşiviniz, oturum bilgileriniz ve ayarlarınız bilgisayarınızda kalır; uygulama UYAP dışında hiçbir sunucuya bağlanmaz ve kullanım verisi toplamaz.

## Portal yükü ve sorumluluk

UYAP Avukat Portalı kullanıcı sözleşmesi, program kullanarak sisteme olumsuz etki yapmayı ya da olağan dışı yük bindirmeyi yasaklıyor. Bu kurala aykırı davrandığı değerlendirilen hesaplara portal erişim engeli uygulanabiliyor. Tensip bu nedenle portala aynı anda yalnızca tek bir istek gönderir ve portalın bildirdiği sınırlara uyar (örneğin safahat sorgusunu dosya başına saatte bir kez yapar). Ayrıca aşağıdaki frenler her zaman açıktır:

| Fren | Varsayılan | Bayrak |
|---|---|---|
| İki istek arasındaki bekleme | 3 sn ile 5 sn arasında, her istekte rastgele seçilir | `--istek-aralik MS` (alt sınır), `--istek-sapma MS` |
| Günlük portal isteği | 500 (giriş doğrulaması ve oturum yenileme dâhil) | `--gunluk-istek-tavan N` |
| Günlük dosya işi (eşitleme, klonlama) | 40 | `--gunluk-tavan N` |

Bekleme her istekte yeniden çekildiği için istekler sabit bir ritimle gitmez. Günlük sayaçlar İstanbul saatine göre gece yarısı sıfırlanır ve motor yeniden başlatılsa da korunur. Tavan dolduğunda istek portala hiç gönderilmez, iş bir sonraki gün kaldığı yerden eşitlenebilir. 500 istek, yüzer evraklık dört dosyayı bir günde arşive almaya yeter; büyük bir arşivin ilk indirmesi birkaç güne yayılabilir.

Daha temkinli çalışmak isterseniz motoru şöyle başlatabilirsiniz:

```bash
tensipd baslat --istek-aralik 6000 --gunluk-istek-tavan 200 --gunluk-tavan 10
```

Bu sınırlar portal hesabınızın güvende kalacağına dair bir garanti değildir. Uygulamayı kullanıp kullanmamaya ve nasıl kullanacağınıza siz karar verirsiniz; sorumluluk da size aittir. Yazılım lisansta belirtildiği gibi "olduğu gibi" sunulur.

## Gereksinimler

| Gereksinim | Ne için |
|---|---|
| macOS | Masaüstü penceresi. Motor ve komut satırı Node.js'in çalıştığı başka sistemlerde de çalışabilir ama yalnızca macOS'ta denendi. |
| Node.js 22 veya üstü | Motor, komut satırı, derleme ve testler |
| Python 3 | Motorun tek kopya çalışmasını sağlayan kilit yardımcısı |
| Chrome, Brave ya da Edge | Portal girişi. Giriş sizin tarayıcı pencerenizde, e-Devlet, e-imza ya da mobil imza ile yapılır. |
| Xcode komut satırı araçları | Yalnızca `.app` paketini derlerken (`xcode-select --install`) |
| `pdftotext` (isteğe bağlı) | PDF evraklardan metin çıkarmak için (`brew install poppler`) |

## Kurulum

```bash
git clone https://github.com/afsozer/tensip.git
cd tensip
./kur.sh
```

`kur.sh` bağımlılıkları kurar, projeyi derler, testleri sahte bir portala karşı çalıştırır ve `tensip` ile `tensipd` komutlarını sisteme ekler. Testler gerçek UYAP'a hiç bağlanmaz.

Masaüstü uygulamasını da kurmak isterseniz:

```bash
./uygulama/uygulama-kur.sh
```

Bu betik `/Applications/Tensip.app` paketini oluşturur. Uygulamayı Launchpad'den ya da Spotlight'tan açtığınızda motor arka planda başlar ve pencere açılır.

## Kullanım

Masaüstü uygulamasında giriş, sol alttaki düğmeyle başlar. Açılan tarayıcı penceresinde e-Devlet adımlarını siz tamamlarsınız; Tensip oturum açıldığı anı tarayıcının kendi trafiğinden anlar ve oturumu devralır. Sonra dosyalarınızı listeleyip arşive alabilirsiniz.

Aynı işleri komut satırından da yapabilirsiniz:

```bash
tensipd baslat                      # motoru ve yerel panoyu başlatır
tensip giris --cdp                  # tarayıcıda portal girişini açar
tensip davalarim --birim "Denizli 1. Asliye Hukuk Mahkemesi" --yil 2026 --sira 1
tensip klonla --birim "Denizli 1. Asliye Hukuk Mahkemesi" --esas 2026/1
tensip esitle --dava "Denizli 1. Asliye Hukuk Mahkemesi 2026-1"
tensip durusmalar --gun 7           # önümüzdeki haftanın duruşmaları
tensip --help                       # bütün komutlar ve kullanım satırları
tensipd durdur
```

Komutlar sonuçlarını standart çıktıya JSON olarak yazar; ilerleme ve günlük kayıtları standart hataya gider. Bu sayede çıktıyı `jq` gibi araçlarla işleyebilirsiniz.

## Veriler nerede durur

| Konum | İçerik |
|---|---|
| `~/Documents/Tensip/` | Dava arşivi: her dosya için bir klasör, evrakın aslı, çıkarılmış metni ve kayıt dosyası |
| `~/.config/tensip/` | Ayarlar, oturum, iş geçmişi ve günlük kayıtları |

Arşiv konumunu `tensipd baslat --kok <dizin>` ile değiştirebilirsiniz.

## Geliştirme

```bash
npm ci
npm test        # derler ve bütün testleri sahte portala karşı çalıştırır
```

Kaynak TypeScript ile yazıldı ve çalışma zamanında npm bağımlılığı yoktur. `src/` motoru, portal istemcisini, arşiv deposunu ve komut satırını; `web/` yerel panoyu; `uygulama/` macOS penceresini ve kurulum betiklerini içerir. Testler `test/` altındaki sahte UYAP sunucusunu kullanır.

## Lisans

Tensip [GNU Affero Genel Kamu Lisansı 3.0](LICENSE) (AGPL-3.0-or-later) ile lisanslanmıştır. Kodu kullanabilir, değiştirebilir ve dağıtabilirsiniz. Ancak değiştirdiğiniz bir sürümü dağıtıyor ya da ağ üzerinden hizmet olarak sunuyorsanız, kaynak kodunu da aynı lisansla paylaşmanız gerekir.

Telif hakkı © 2026 Av. Alpaslan Fatih Sözer
