// Daemon tek örnek kilidi.
//
// Sabit dosya üzerinde süreçle bırakılan flock kullanılır. Kilit dosyası
// unlink edilmez: eski sahibin kapanma/yeniden başlatma yarışında yeni
// sahibin dosyasını silmek mümkün değildir. Python yardımcı süreç stdin EOF
// ile parent ölümünde çıkar ve flock'i işletim sistemine bıraktırır.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { Hata } from "../core/errors.js";

export const KILIT_DOSYA = ".tensipd.lock";

const YARDIMCI = String.raw`
import fcntl, os, sys
path, owner = sys.argv[1], sys.argv[2]
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    os.close(fd)
    print("BUSY", flush=True)
    raise SystemExit(6)
os.ftruncate(fd, 0)
os.write(fd, owner.encode("utf-8"))
print("READY", flush=True)
try:
    while sys.stdin.buffer.read(1):
        pass
finally:
    os.close(fd)
`;

export class SurecKilidi {
  private readonly yol: string;
  private cocuk?: ChildProcessByStdio<Writable, Readable, null>;
  private birakildi = false;
  private kayip?: () => void;
  private cikis?: Promise<void>;

  constructor(private readonly dizin: string, private readonly instanceId: string) {
    this.yol = join(dizin, KILIT_DOSYA);
  }

  kayipta(fn: () => void): void {
    if (!this.cocuk || this.cocuk.exitCode !== null || this.cocuk.signalCode !== null) {
      throw new Hata("INTERNAL", "başlatma sırasında süreç kilidi kaybedildi");
    }
    this.kayip = fn;
  }

  async edin(): Promise<void> {
    const child = spawn("python3", ["-u", "-c", YARDIMCI, this.yol, JSON.stringify({ version: 1, instanceId: this.instanceId, pid: process.pid })], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.cocuk = child;
    this.cikis = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.stdin.on("error", () => { /* kapanmış yardımcıya EOF yazılması */ });
    const cikti: string[] = [];
    const hazir = new Promise<void>((coz, red) => {
      const zaman = setTimeout(() => red(new Hata("IS_BUSY", "tensipd süreç kilidi alınamadı; başka bir başlatma sürüyor")), 2_000);
      child.stdout.on("data", (parca: Buffer) => {
        cikti.push(parca.toString("utf8"));
        const metin = cikti.join("");
        if (metin.includes("READY\n")) {
          clearTimeout(zaman);
          coz();
        } else if (metin.includes("BUSY\n")) {
          clearTimeout(zaman);
          red(new Hata("IS_BUSY", "tensipd zaten çalışıyor; önce onu durdurun: tensipd durdur"));
        }
      });
      child.once("error", (e) => {
        clearTimeout(zaman);
        red(new Hata("INTERNAL", `Süreç kilidi başlatılamadı; python3 ve fcntl gerekli: ${e.message}`));
      });
      child.once("exit", (kod) => {
        if (kod !== null && kod !== 0) {
          clearTimeout(zaman);
          red(new Hata(kod === 6 ? "IS_BUSY" : "INTERNAL", kod === 6 ? "tensipd zaten çalışıyor; önce onu durdurun: tensipd durdur" : "süreç kilidi yardımcısı başlatılamadı"));
        }
      });
    });
    try {
      await hazir;
    } catch (e) {
      await this.birak();
      throw e;
    }
    child.once("exit", () => {
      if (!this.birakildi) this.kayip?.();
    });
  }

  async birak(): Promise<void> {
    if (this.birakildi) return;
    this.birakildi = true;
    const child = this.cocuk;
    this.cocuk = undefined;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    // EOF'ye yanıt veremeyen yardımcı da kilidi elde tutamaz.
    const zaman = setTimeout(() => child.kill("SIGKILL"), 1_000);
    try { await this.cikis; }
    finally { clearTimeout(zaman); }
  }
}
