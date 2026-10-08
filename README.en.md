<p align="center"><img src="uygulama/tensip.iconset/icon_256x256.png" width="128" alt="Tensip"></p>

# Tensip

**Project page:** [avfatihsozer.com/en/projects/tensip](https://avfatihsozer.com/en/projects/tensip) · Türkçe: [README.md](README.md)

Tensip is an open-source helper app that downloads your case files from the UYAP Lawyer Portal (the lawyer portal of Türkiye's judicial information system) into a tidy archive on your own computer, keeps that archive in sync with the portal and shows the documents in a readable form on your desktop. The app's interface is in Turkish.

> **Tensip is not an official application.** It has no connection to the Ministry of Justice, UYAP or any bar association, and it is not developed, approved or supported by them.

![Tensip, Downloads screen: the files in the archive, the documents of the selected file and a preview of the document text](.github/ekran/indirilenler.png)

## What it does

- **File list:** Lists the civil, criminal and enforcement files you represent, without entering a court, year and number.
- **Archive and sync:** Downloads the documents of a chosen file into a local folder; later syncs fetch only new or changed documents.
- **Preview:** Shows UDF and text-layer PDF documents as text inside the app.
- **File details:** Shows the case history, parties and account details on the file screen.
- **Calendar:** Lists upcoming hearings and site inspections and exports them to macOS Calendar.
- **Audit and repair:** Finds missing, damaged or duplicate records in the archive and repairs those that can be fixed safely.
- **Three interfaces:** A macOS app window, a local dashboard opened in the browser (`http://127.0.0.1:4747`) and a command line with JSON output (`tensip`).

<table>
  <tr>
    <td width="33%"><a href=".github/ekran/dosyalar.png"><img src=".github/ekran/dosyalar.png" alt="Files screen: the list of files on UYAP"></a></td>
    <td width="33%"><a href=".github/ekran/ajanda.png"><img src=".github/ekran/ajanda.png" alt="Calendar screen: upcoming hearings grouped by day"></a></td>
    <td width="33%"><a href=".github/ekran/safahat.png"><img src=".github/ekran/safahat.png" alt="File details: case history records"></a></td>
  </tr>
  <tr>
    <td align="center"><sub>File list</sub></td>
    <td align="center"><sub>Calendar</sub></td>
    <td align="center"><sub>Case history</sub></td>
  </tr>
</table>

The files and parties in the screenshots are made up.

## What it does not do

Tensip does not send documents or petitions to UYAP and does not sign anything; on the portal it only runs queries and downloads documents. Your archive and session details stay on your computer, and the app connects to no server other than UYAP.

## Portal load and responsibility

The Lawyer Portal's user agreement forbids placing unusual load on the system with software, and access to the portal can be blocked for a breach. Tensip therefore sends one request at a time to the portal, respects the portal's own limits and applies these brakes:

| Brake | Default | Flag |
|---|---|---|
| Wait between two requests | Between 3 and 5 seconds, chosen at random for each request | `--istek-aralik MS` (lower bound), `--istek-sapma MS` |
| Portal requests per day | 500 (including sign-in checks and session refreshes) | `--gunluk-istek-tavan N` |
| File jobs per day (sync, clone) | 40 | `--gunluk-tavan N` |

The daily counters reset at midnight Istanbul time; once a cap is reached no request is sent, and syncing resumes the next day where it left off.

These limits do not guarantee that your account will stay safe; you are responsible for how you use the app.

## Requirements

| Requirement | Used for |
|---|---|
| macOS | The desktop window (the engine and command line have also been tried only on macOS) |
| Node.js 22 or later | Engine, command line, build and tests |
| Python 3 | The engine's lock helper |
| Chrome, Brave or Edge | Signing in to the portal through e-Devlet |
| Xcode command line tools | Building the `.app` bundle (`xcode-select --install`) |
| `pdftotext` (optional) | Extracting text from PDF documents (`brew install poppler`) |

## Installation

```bash
git clone https://github.com/afsozer/tensip.git
cd tensip
./kur.sh
```

`kur.sh` builds the project, runs the tests and installs the `tensip` and `tensipd` commands. For the desktop app:

```bash
./uygulama/uygulama-kur.sh
```

## Usage

Start the sign-in with the button at the bottom left of the app window; once you complete the e-Devlet steps in the browser that opens, Tensip takes over the session. From the command line:

```bash
tensipd baslat                      # starts the engine and the local dashboard
tensip giris --cdp                  # opens the portal sign-in in the browser
tensip davalarim --birim "Denizli 1. Asliye Hukuk Mahkemesi" --yil 2026 --sira 1
tensip klonla --birim "Denizli 1. Asliye Hukuk Mahkemesi" --esas 2026/1
tensip esitle --dava "Denizli 1. Asliye Hukuk Mahkemesi 2026-1"
tensip durusmalar --gun 7           # hearings in the coming week
tensip --help                       # all commands and usage lines
tensipd durdur
```

## Where the data lives

| Location | Contents |
|---|---|
| `~/Documents/Tensip/` | Case archive (change it with `tensipd baslat --kok <directory>`) |
| `~/.config/tensip/` | Settings, session and job history |

## Development

```bash
npm ci
npm test        # builds and tests against a mock portal
```

To try the app without connecting to the real UYAP, there is a demo environment filled with made-up files:

```bash
npm run build && node bin/demo.mjs 4848    # http://127.0.0.1:4848
```

`src/` holds the engine, the portal client and the command line, `web/` the local dashboard and `uygulama/` the macOS window.

## License

Tensip is licensed under [AGPL-3.0-or-later](LICENSE); anyone who distributes a modified version or offers it over a network must share its source code under the same license.

Copyright © 2026 Av. Alpaslan Fatih Sözer
