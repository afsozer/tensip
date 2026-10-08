import AppKit
import WebKit

final class Uygulama: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var pencere: NSWindow!
    var web: WKWebView!
    var adres: URL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let aday = CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:4747"
        guard let url = URL(string: aday), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else {
            NSApp.terminate(nil); return
        }
        adres = url
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        let ayar = WKWebViewConfiguration()
        ayar.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: ayar)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        pencere = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 850),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        pencere.title = "Tensip"
        pencere.minSize = NSSize(width: 820, height: 620)
        pencere.backgroundColor = NSColor(calibratedRed: 0.055, green: 0.048, blue: 0.044, alpha: 1)
        pencere.titlebarAppearsTransparent = true
        pencere.contentView = web
        pencere.setFrameAutosaveName("UYAPAsistanAnaPencere")
        pencere.center()
        menuKur()
        pencere.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.load(URLRequest(url: url))
    }
    func menuKur() {
        let menu = NSMenu()
        let ana = NSMenuItem()
        let uygulamaMenu = NSMenu(title: "Tensip")
        uygulamaMenu.addItem(withTitle: "Tensip’ten Çık", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        ana.submenu = uygulamaMenu
        menu.addItem(ana)
        let duzen = NSMenuItem()
        let duzenMenu = NSMenu(title: "Düzen")
        for (ad, secici, tus) in [("Geri Al", "undo:", "z"), ("Kes", "cut:", "x"), ("Kopyala", "copy:", "c"), ("Yapıştır", "paste:", "v"), ("Tümünü Seç", "selectAll:", "a")] {
            duzenMenu.addItem(withTitle: ad, action: Selector(secici), keyEquivalent: tus)
        }
        duzen.submenu = duzenMenu
        menu.addItem(duzen)
        let gorunum = NSMenuItem()
        let gorunumMenu = NSMenu(title: "Görünüm")
        let yenile = gorunumMenu.addItem(withTitle: "Yenile", action: #selector(yenileSayfa), keyEquivalent: "r")
        yenile.target = self
        gorunum.submenu = gorunumMenu
        menu.addItem(gorunum)
        NSApp.mainMenu = menu
    }
    @objc func yenileSayfa() { web.load(URLRequest(url: adres)) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        pencere?.makeKeyAndOrderFront(nil); return true
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == adres.scheme && url.host == adres.host && url.port == adres.port {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        let uyari = NSAlert()
        uyari.messageText = "Uygulamaya bağlanılamadı"
        uyari.informativeText = "Yerel motor yanıt vermedi. Yeniden deneyebilir veya uygulamayı kapatıp açabilirsiniz."
        uyari.addButton(withTitle: "Yeniden dene")
        uyari.addButton(withTitle: "Kapat")
        uyari.beginSheetModal(for: pencere) { cevap in
            if cevap == .alertFirstButtonReturn { self.yenileSayfa() }
            else { NSApp.terminate(nil) }
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let uyari = NSAlert()
        uyari.messageText = message
        uyari.addButton(withTitle: "Devam et")
        uyari.addButton(withTitle: "Vazgeç")
        uyari.beginSheetModal(for: pencere) { completionHandler($0 == .alertFirstButtonReturn) }
    }
}
let uygulama = Uygulama()
let app = NSApplication.shared
app.delegate = uygulama
app.run()
