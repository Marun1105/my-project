# Releasing a new version of Climby

> **The version number lives in one place.** Change it in `package.json`, then
> read `X.Y.Z` below as that number. If the two disagree, the update is simply
> never offered to anyone — the updater looks for exactly that number.

From **1.0.2** on, Climby updates itself: on launch it checks GitHub Releases,
downloads the new version quietly in the background, and asks the student to
restart.

**About users still on 1.0.1:** they will not update by themselves. 1.0.1 was
built before the app had an updater — it doesn't know where to look. Anyone on
it has to install X.Y.Z by hand **one last time**. After that everything is
automatic. A ready-to-paste message for them is at the bottom.

---

## 1. Before releasing

1. Check that everything works: `python -m pytest -q` in the project folder.
2. Raise the version in `desktop/package.json` → `"version"`.
   The rule is simple: a fix → `X.Y.Z+1`, a new feature → `1.Y+1.0`.
   **The number must be greater than the previous one, or the app won't see
   the update.**
3. Commit that change.

## 2. Building

```
cd desktop
npm run dist            # Windows: installer + portable
npm run dist:linux      # Linux: AppImage
npm run dist:store      # Microsoft Store package (see §5)
```

`desktop/dist/` then contains:

| File | What it's for |
|---|---|
| `Climby-Setup-X.Y.Z.exe` | the installer — this is what a person downloads |
| `Climby-Setup-X.Y.Z.exe.blockmap` | lets the next update download only the difference (a few MB instead of 100) |
| `latest.yml` | where the Windows app looks for the newest version |
| `Climby-X.Y.Z-portable.exe` | no-install variant; **does not update itself** |
| `Climby-X.Y.Z.AppImage` | Linux; runs on any distribution, updates itself |
| `latest-linux.yml` | where the Linux app looks for the newest version |
| `Climby-X.Y.Z-store.appx` | for the Microsoft Store only; not for GitHub Releases |

## 3. Uploading to GitHub Releases

### Option A — automatic (easier once set up)

You need a GitHub token:
GitHub → Settings → Developer settings → Personal access tokens → Tokens
(classic) → Generate new token → tick **`repo`** → Generate.
Copy the token (it is shown once).

Then, in PowerShell:

```
cd C:\Users\Admin\Documents\project\desktop
$env:GH_TOKEN = "<YOUR TOKEN — DO NOT WRITE IT IN THIS FILE>"
npm run release
```

This builds and uploads everything by itself, tagged `vX.Y.Z`.

> **Never paste the token here.** This file is in the repo, and the repo is
> public — one `git add` separates a pasted token from being visible to
> everyone. It has already happened twice: both times the token was caught in
> the working tree before it reached a commit, but that is luck, not
> protection.
>
> Pass it only on the console line, at the moment of release —
> `$env:GH_TOKEN` lives as long as the PowerShell window and is stored nowhere.

### Option B — by hand

1. Open https://github.com/Marun1105/my-project/releases → **Draft a new release**.
2. **Tag:** `vX.Y.Z` (the letter `v` + the number from `package.json`).
3. Drag in **all of** these: `Climby-Setup-X.Y.Z.exe`,
   `Climby-Setup-X.Y.Z.exe.blockmap`, `latest.yml`, and — if you built Linux —
   `Climby-X.Y.Z.AppImage` and `latest-linux.yml`.
4. Press **Publish release** — not "Save draft".
   A draft is invisible to installed copies: electron-updater asks
   `/releases/latest`, which never returns drafts. The files sit on GitHub,
   look uploaded, and every app keeps insisting it is up to date — and nobody
   finds out until they open the page and see the "Draft" label.
   (`package.json` says `releaseType: release`, but that only applies to
   `npm run release`; a release made by hand is a draft by default.)

### Before pressing Publish: check that `latest.yml` describes exactly this file

This has happened once: `latest.yml` was left over from the previous build and
pointed at a different size and checksum. Such a release downloads and is then
rejected at verification — the update fails silently for everyone.

```bash
cd desktop/dist
python -c "
import hashlib,base64,re,os
y=open('latest.yml',encoding='utf-8').read()
f=re.search(r'path: (\S+)',y).group(1)
h=base64.b64encode(hashlib.sha512(open(f,'rb').read()).digest()).decode()
print('size  :', os.path.getsize(f)==int(re.search(r'size: (\d+)',y).group(1)))
print('sha512:', h==re.search(r'^sha512: (\S+)',y,re.M).group(1))
"
```

Both must be `True`. If not, rebuild and upload the files together. Drafts and
"pre-release" versions are not seen by the app.

**Do not rename the files.** The names deliberately contain no spaces: GitHub
replaces spaces with dots, and `latest.yml` points at the exact name. If they
don't match, the app looks for a file that doesn't exist and the update fails
silently.

## 4. Checking that it worked

Open the installed Climby → menu **Help → Check for Updates**.

- "Climby is up to date." → you're already on the new one.
- "A new version is available: X.Y.Z." → it works; the download starts in the background.
- "We could not check for updates." → either no internet, or something in the
  release is wrong (a draft, a missing `latest.yml`, a renamed file).

To see exactly what's happening, start the app from a terminal and watch the
lines beginning with `[updater]`.

---

## 5. The Microsoft Store

The Store is the only way to remove the "Windows protected your PC" screen: Store
apps are re-signed by Microsoft and never show it. (A code-signing certificate
no longer does this — Microsoft's own guidance says so.)

**Once:** an individual developer account at
https://partner.microsoft.com/dashboard/registration ($19, one time). Then, in
Partner Center → your app → **Product management → Product identity**, copy the
three values into `package.json` → `build.appx`:

| Partner Center | `package.json` |
|---|---|
| Package/Identity/Name | `identityName` |
| Package/Identity/Publisher | `publisher` (starts with `CN=`) |
| Package/Properties/PublisherDisplayName | `publisherDisplayName` |

They must match character for character or the upload is rejected. The Store
also needs a privacy policy URL: https://marun1105.github.io/my-project/privacy.html.

**Each release:** `npm run dist:store`, then upload
`dist/Climby-X.Y.Z-store.appx` in Partner Center → Packages. The package is
deliberately unsigned; the Store signs it. Store copies update through the
Store, not through GitHub Releases, so the updater is not involved.

## 6. Linux

`npm run dist:linux` produces an AppImage. It needs no installation: the user
marks it executable and runs it. It updates itself from GitHub Releases the
same way Windows does, as long as `latest-linux.yml` is uploaded alongside it.

---

## Message for friends (to copy)

> Hi! There's a new version of Climby. This once you have to install it by
> hand — only this once. Download `Climby-Setup-X.Y.Z.exe` from
> https://github.com/Marun1105/my-project/releases
> and run it. It installs over the old one; nothing is lost.
>
> Windows may show a blue "Windows protected your PC" screen — that's because
> the app isn't paid up for a signature, not because it's a virus. Click
> **More info → Run anyway**.
>
> From here on Climby updates itself — it'll just ask you to restart when
> there's something new.
