# Delta Vault for Android

A tactical-style file manager for your phone. It browses the real storage on the
device (internal storage and SD cards), and can open, preview, copy, move, rename,
delete, search and share files.

On first launch it shows an **Access required** screen and asks for:

1. **Photos, videos and audio** (a normal Android permission dialog), and
2. **All files access** (Android 11 and newer). Android opens a settings page.
   Switch the option on for Delta Vault, then press back to return.

Without "All files access" the app still runs in limited mode, but many folders
and files stay hidden because of Android's storage rules.

Works on Android 5.1 and newer.

---

## Get the APK (pick one)

### Option A: Build in the cloud with GitHub (nothing to install)

1. Create a new repository on github.com (private is fine).
2. From this folder, push the project:

   ```bash
   git init
   git add .
   git commit -m "Delta Vault"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/delta-vault.git
   git push -u origin main
   ```

   (Make sure the hidden `.github/workflows/build-apk.yml` file is included.)
3. Open the repository's **Actions** tab. The **Build Android APK** run starts
   automatically and takes about 5 minutes. You can also start it with
   **Run workflow**.
4. When it finishes, open the run and download the **delta-vault-apk** artifact.
   Unzip it to get `app-debug.apk`.

### Option B: Build on your computer with Android Studio

You need Node.js 18 or newer and Android Studio (it brings its own JDK 17).

```bash
npm install
npx cap sync android
npx cap open android
```

In Android Studio wait for Gradle to finish syncing, then choose
**Build > Build Bundle(s) / APK(s) > Build APK(s)**. The file is created at
`android/app/build/outputs/apk/debug/app-debug.apk`.

Or from a terminal, with the Android SDK installed:

```bash
cd android
./gradlew assembleDebug
```

## Install on the phone

1. Copy `app-debug.apk` to the phone and open it.
2. When Android asks, allow your file app or browser to **install unknown apps**.
3. Open Delta Vault and follow the **Access required** screen.

## Changing the app

- The interface lives in `www/` (`index.html`, `css/app.css`, `js/app.js`).
- The native file code lives in
  `android/app/src/main/java/com/deltavault/files/DeltaFilesPlugin.java`.
- After editing anything in `www/`, run `npx cap sync android` and build again.
- App name and id: `capacitor.config.json` (then run `npx cap sync android`).
  Changing the id also means renaming the Java package folders.

## What it can do

| Action | How |
| --- | --- |
| Browse folders | Tap a folder; use the breadcrumb or the Locations drawer |
| Select several | Long press, or tap the corner box; tap to add more |
| Inspect a file | Tap it: preview for images, video, audio and text |
| Open in another app | Inspector > Open |
| Copy / Cut / Paste | Inspector buttons, then **Paste** in the target folder |
| Rename, delete, new folder | Inspector buttons and the toolbar |
| Share | Inspector > Share |
| Search | Search box: looks inside the current folder and all subfolders |
| Hidden files | Eye button in the toolbar |
| Back button | Closes panels, goes up a folder, then exits |

## Good to know

- **Delete is permanent.** There is no recycle bin.
- Android 11 and newer blocks other apps from `Android/data` and `Android/obb`,
  even with All files access. Those folders show as unreadable.
- This is a debug build, which is fine for your own phone. For the Play Store
  you would need a signed release build, and Google only approves
  "All files access" for apps that are file managers.
- The fonts are bundled, so the app works fully offline and sends no data
  anywhere.

## Troubleshooting

- **"Cannot open folder"**: the permission was probably turned off. Tap the
  status chip at the top (it says Limited access) to reopen the permission screen.
- **A photo thumbnail is missing**: very large or unusual image formats fall back
  to an icon. Inspect the file and use Open to view it in your gallery app.
- **Gradle sync fails in Android Studio**: run `npm install` and
  `npx cap sync android` first, then reopen the `android` folder.
