/** Başarılı sonuçları saklar; aynı anahtarın eşzamanlı sorgularını birleştirir. */
export class SorguOnbellek<T> {
  private kayitlar = new Map<string, { at: number; sonuc: Promise<T> }>();
  constructor(private ttlMs: number, private simdi = Date.now) {}
  getir(anahtar: string, sorgu: () => Promise<T>): Promise<T> {
    const eski = this.kayitlar.get(anahtar);
    if (eski && this.simdi() - eski.at < this.ttlMs) return eski.sonuc;
    for (const [k, v] of this.kayitlar) {
      if (this.simdi() - v.at >= this.ttlMs) this.kayitlar.delete(k);
    }
    const kayit = { at: Infinity, sonuc: Promise.resolve().then(sorgu) };
    this.kayitlar.set(anahtar, kayit);
    kayit.sonuc.then(() => { kayit.at = this.simdi(); }, () => {
      if (this.kayitlar.get(anahtar) === kayit) this.kayitlar.delete(anahtar);
    });
    return kayit.sonuc;
  }
  /**
   * `getir` ile aynı, ama sonucun YAŞINI da verir: `at` verinin ÖLÇÜLDÜĞÜ an,
   * `onbellekten` bu çağrının sorguyu yeniden çalıştırıp çalıştırmadığıdır.
   * Ekranda "son sorgu" diye tıklama anını göstermek yanıltıcıdır — 10 dk'lık
   * önbellekten dönen veri tıklama anı kadar taze görünür.
   */
  async getirDamgali(
    anahtar: string,
    sorgu: () => Promise<T>,
  ): Promise<{ deger: T; at: number; onbellekten: boolean }> {
    const eski = this.kayitlar.get(anahtar);
    // `at` süren bir sorguda Infinity'dir: ona katılan çağrı da portala
    // gitmez, o yüzden "önbellekten" sayılır.
    const onbellekten = !!eski && this.simdi() - eski.at < this.ttlMs;
    const deger = await this.getir(anahtar, sorgu);
    const kayit = this.kayitlar.get(anahtar);
    const at =
      kayit && Number.isFinite(kayit.at) ? kayit.at : this.simdi();
    return { deger, at, onbellekten };
  }
}
