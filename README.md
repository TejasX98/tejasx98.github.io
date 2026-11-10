# Tejas Chaudhari — Portfolio

```
portfolio/
├─ site/                 ← the website (only this folder goes on the internet)
│  ├─ content/           ← site.yml · projects.yml · publications.yml
│  └─ media/             ← photos, videos, PDFs (one folder per project)
├─ admin/                ← the local editor (never published)
├─ start-admin.bat       ← double-click on Windows to open the editor
├─ start-admin.command   ← same, for Mac
└─ .github/workflows/    ← tells GitHub to publish site/ automatically
```

**Day to day:** double-click `start-admin.bat` → edit in the browser → **Save** → **Publish**. The live site updates about a minute later.

---

## 1. One-time setup (about 20 minutes)

### 1a. Install the tools (Windows)
1. **Git** — https://git-scm.com/download/win → install with the defaults. This includes *Git Credential Manager*, which handles your GitHub sign-in safely.
2. **Python 3** — https://www.python.org/downloads/ → on the first screen tick **“Add python.exe to PATH”**.
3. *(Optional)* **ffmpeg** to auto-compress videos: open PowerShell and run `winget install ffmpeg`.

### 1b. Secure your GitHub account first
- Settings → **Password and authentication** → turn on **two-factor authentication** (an authenticator app or passkey, not SMS if you can avoid it).
- Save the recovery codes somewhere safe (password manager).
- Settings → **Emails** → tick **“Keep my email addresses private”**. Commits will then use a `@users.noreply.github.com` address instead of your Gmail.

### 1c. Create the repository
1. On GitHub: **+ → New repository**.
2. Name it exactly **`tejasx98.github.io`** (your username + `.github.io`). Set it to **Public** (free Pages needs a public repo). Don't add a README.
3. On your PC, open the folder that contains this README, right-click → **Open Git Bash here**, and run:

```bash
git config --global user.name "Tejas Chaudhari"
git config --global user.email "YOUR-ID+TejasX98@users.noreply.github.com"   # shown on github.com/settings/emails
git init -b main
git add .
git commit -m "First version of portfolio"
git remote add origin https://github.com/TejasX98/tejasx98.github.io.git
git push -u origin main
```
The first `git push` opens a GitHub sign-in window. After that, the admin tool can publish without asking again. No password or token is stored in this folder.

### 1d. Turn on GitHub Pages
Repository → **Settings → Pages** → **Source: GitHub Actions**. The workflow in `.github/workflows/pages.yml` publishes only the `site/` folder on every push. Watch progress in the **Actions** tab. When it shows a green tick, the site is live at **https://tejasx98.github.io**.

Then: **Settings → Pages → tick “Enforce HTTPS”** (it's usually on already for github.io).

---

## 2. Editing with the admin tool

Double-click **`start-admin.bat`** (first run installs two small Python packages). A browser tab opens at `http://127.0.0.1:8321`.

| Tab | What you do there |
|---|---|
| **Projects** | + New project, edit text, drag in photos/videos/PDFs, add YouTube links and buttons, set the ★ cover, reorder with ▲▼, tick *Show on live site*, delete |
| **Publications** | Add papers, link to IEEE Xplore/DOI, attach a PDF, reorder |
| **Profile** | Photo, CV upload, and all profile text (intro, highlights, skills, experience, education) |
| **Publish** | See what changed → **Publish to GitHub**. Also *Get latest from GitHub* and *Tidy up unused media* |

- New projects start as **drafts** (hidden). Preview with **Preview page ↗**, then tick *Show on live site*.
- Photos are resized to max 1920 px and **their location/camera data is removed** automatically.
- Videos are compressed if ffmpeg is installed. Over 100 MB isn't allowed by GitHub, so use YouTube (Unlisted) for long videos.
- Close the black window (or press Ctrl+C) to stop the editor.

You can still edit `site/content/*.yml` by hand, or on github.com with the ✏️ pencil. If you do edit on github.com, press **Get latest from GitHub** in the admin before your next publish.

---

## 3. How safe is this?

**The live site**
- It's static files only: no server, database, login or contact form to break into. That is the biggest security win.
- HTTPS is enforced by GitHub Pages.
- A Content-Security-Policy is set in both pages. Only the site's own scripts run, and embeds are limited to YouTube's privacy-enhanced player.
- Links are filtered: `javascript:` and similar links are blocked, and raw HTML in write-ups is ignored.
- Only `site/` is deployed. The admin tool, launchers and this README never go on the web.
- The deploy workflow checks your content files before publishing. A broken edit fails in *Actions* instead of breaking the live site.

**The admin tool**
- It listens on `127.0.0.1` only, so other devices on your Wi-Fi can't reach it.
- It checks the `Host` header, which blocks "DNS rebinding" tricks from websites.
- Every change needs a random per-session token, so other websites in your browser can't post to it.
- Uploads are limited to images, MP4/WebM video and PDF. Images are re-encoded, and files can only be written inside `site/media/`.
- Publishing refuses files over GitHub's limit and anything that looks like a key or secret file.

**Your part**
- [ ] 2-factor authentication on GitHub, and a private commit email (step 1b)
- [ ] **No phone number, home address or date of birth** on the site or the CV PDF you upload. Email + LinkedIn is enough.
- [ ] No confidential client material (site photos, drawings, PLC code, client names) unless you have written permission
- [ ] Ask teammates before posting photos where they're clearly identifiable, and credit them in **Team / credit**
- [ ] Don't upload certificates showing registration/roll numbers, or other people's certificates
- [ ] **Old repository** `Profile_Website` (your old repository): its history contains an old template page with your date of birth, part of your phone number and an old email. If it's public, make it **private** or delete it (Settings → General → Danger Zone).

---

## 4. Custom domain (optional)

The free address `tejasx98.github.io` is fine for applications. If you want `tejaschaudhari.com` or similar:

1. Buy the domain (roughly £8–12/year). Cloudflare Registrar sells at cost; Namecheap and Porkbun are also fine. Avoid "free domain" sites: they get recycled and abused.
2. **Verify the domain on GitHub first**: your profile Settings → *Pages* → *Add a domain*, then add the TXT record it gives you. This stops anyone else attaching your domain to their site (domain takeover).
3. Add DNS records at your registrar: four `A` records for the apex pointing to GitHub Pages' IPs (listed in GitHub's docs), and a `CNAME` for `www` → `tejasx98.github.io`. **Don't use wildcard (`*`) records.**
4. Repository → Settings → Pages → *Custom domain* → enter it → wait for the certificate → tick **Enforce HTTPS**.
5. Change `url:` in `site.yml` (Profile tab) to the new address.

---

## 5. If something goes wrong

| Problem | Fix |
|---|---|
| The admin says *Git doesn't know who you are* | Run the two `git config --global` lines from step 1c |
| *GitHub sign-in needed* | Run `git push` once in Git Bash, sign in, then publish again |
| *GitHub has changes you don't have locally* | Press **Get latest from GitHub**, then Publish |
| Live site shows a red “Something needs fixing” box | A content file has a formatting error. Open the admin; it shows the line |
| Actions tab shows a red ✗ | Click it to read the error. Usually a typo in a `.yml` file |
| Want to undo a publish | On GitHub: the repo's commit history → revert, or ask for help |
