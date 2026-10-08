// Minimal ZIP okuyucu (yalnız okuma): UDF kapağını açmak için.
// node:zlib inflateRaw ile deflate'li girdileri açar; store'a dokunmaz.

import { inflateRawSync } from "node:zlib";

export interface ZipGirdi {
  ad: string;
  boyut: number;
  /** ham (store) mu deflate mi */
  yontem: "store" | "deflate";
  veri: Buffer;
}

interface MerkeziKayit {
  imzaOk: boolean;
  yontem: number;
  sıkıştırılmışBoyut: number;
  hamBoyut: number;
  adUzunluk: number;
  ekAlanUzunluk: number;
  yorumUzunluk: number;
  yerelKafaOfset: number;
  ad: string;
}

const MERKEZI_IMZA = 0x02014b50;

/** ZIP merkezi dizinini tarar. */
function merkeziDizin(buf: Buffer): MerkeziKayit[] {
  // EOCD'yi sondan ara
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip EOCD bulunamadı");
  const adet = buf.readUInt16LE(eocd + 10);
  let ofset = buf.readUInt32LE(eocd + 16);
  const kayitlar: MerkeziKayit[] = [];
  for (let i = 0; i < adet; i++) {
    if (buf.readUInt32LE(ofset) !== MERKEZI_IMZA) break;
    const yontem = buf.readUInt16LE(ofset + 10);
    const sıkıştırılmışBoyut = buf.readUInt32LE(ofset + 20);
    const hamBoyut = buf.readUInt32LE(ofset + 24);
    const adUzunluk = buf.readUInt16LE(ofset + 28);
    const ekAlanUzunluk = buf.readUInt16LE(ofset + 30);
    const yorumUzunluk = buf.readUInt16LE(ofset + 32);
    const yerelKafaOfset = buf.readUInt32LE(ofset + 42);
    const ad = buf.subarray(ofset + 46, ofset + 46 + adUzunluk).toString("utf8");
    kayitlar.push({
      imzaOk: true,
      yontem,
      sıkıştırılmışBoyut,
      hamBoyut,
      adUzunluk,
      ekAlanUzunluk,
      yorumUzunluk,
      yerelKafaOfset,
      ad,
    });
    ofset += 46 + adUzunluk + ekAlanUzunluk + yorumUzunluk;
  }
  return kayitlar;
}

/** ZIP'i tamamen belleğe okur ve girdi adlarına göre döndürür. */
export function zipAc(buf: Buffer): Record<string, Buffer> {
  const kayitlar = merkeziDizin(buf);
  const cikti: Record<string, Buffer> = {};
  for (const k of kayitlar) {
    // yerel dosya kafasını oku: ad + ek alan boyutu kayıttan farklı olabilir
    const yerel = k.yerelKafaOfset;
    if (buf.readUInt32LE(yerel) !== 0x04034b50) throw new Error("zip yerel kafa bozuk");
    const yerelAdUzunluk = buf.readUInt16LE(yerel + 26);
    const yerelEkUzunluk = buf.readUInt16LE(yerel + 28);
    const veriOfset = yerel + 30 + yerelAdUzunluk + yerelEkUzunluk;
    const ham = buf.subarray(veriOfset, veriOfset + k.sıkıştırılmışBoyut);
    let veri: Buffer;
    if (k.yontem === 0) {
      veri = Buffer.from(ham); // store
    } else if (k.yontem === 8) {
      veri = inflateRawSync(ham);
    } else {
      throw new Error(`desteklenmeyen zip sıkıştırma yöntemi: ${k.yontem}`);
    }
    cikti[k.ad] = veri;
  }
  return cikti;
}
