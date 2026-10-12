package com.deltavault.files;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.provider.Settings;
import android.webkit.MimeTypeMap;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Native file access for Delta Vault.
 *
 * Handles runtime media permissions, the "All files access" settings flow,
 * directory listing, search, copy / move / rename / delete, text preview,
 * opening files in other apps and sharing.
 *
 * Heavy work runs on a private thread pool so a slow folder never blocks the UI
 * or other plugin calls.
 */
@CapacitorPlugin(
    name = "DeltaFiles",
    permissions = {
        @Permission(alias = "readStorage", strings = { "android.permission.READ_EXTERNAL_STORAGE" }),
        @Permission(alias = "writeStorage", strings = { "android.permission.WRITE_EXTERNAL_STORAGE" }),
        @Permission(alias = "mediaImages", strings = { "android.permission.READ_MEDIA_IMAGES" }),
        @Permission(alias = "mediaVideo", strings = { "android.permission.READ_MEDIA_VIDEO" }),
        @Permission(alias = "mediaAudio", strings = { "android.permission.READ_MEDIA_AUDIO" })
    }
)
public class DeltaFilesPlugin extends Plugin {

    private static final String P_READ = "android.permission.READ_EXTERNAL_STORAGE";
    private static final String P_WRITE = "android.permission.WRITE_EXTERNAL_STORAGE";
    private static final String P_IMG = "android.permission.READ_MEDIA_IMAGES";
    private static final String P_VID = "android.permission.READ_MEDIA_VIDEO";
    private static final String P_AUD = "android.permission.READ_MEDIA_AUDIO";

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private static final AtomicLong LATEST_SEARCH = new AtomicLong(0);

    /* ------------------------------------------------------------------ */
    /* Access                                                              */
    /* ------------------------------------------------------------------ */

    private boolean has(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean mediaGranted() {
        if (Build.VERSION.SDK_INT >= 33) {
            return has(P_IMG) && has(P_VID) && has(P_AUD);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            return has(P_READ);
        }
        return has(P_READ) && has(P_WRITE);
    }

    private boolean allFilesGranted() {
        if (Build.VERSION.SDK_INT >= 30) {
            return Environment.isExternalStorageManager();
        }
        return mediaGranted();
    }

    private JSObject statusObject() {
        JSObject o = new JSObject();
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("media", mediaGranted());
        o.put("allFiles", allFilesGranted());
        return o;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    @PluginMethod
    public void requestMedia(PluginCall call) {
        if (mediaGranted()) {
            call.resolve(statusObject());
            return;
        }
        String[] aliases;
        if (Build.VERSION.SDK_INT >= 33) {
            aliases = new String[] { "mediaImages", "mediaVideo", "mediaAudio" };
        } else if (Build.VERSION.SDK_INT >= 30) {
            aliases = new String[] { "readStorage" };
        } else {
            aliases = new String[] { "readStorage", "writeStorage" };
        }
        requestPermissionForAliases(aliases, call, "mediaPermsCallback");
    }

    @PermissionCallback
    private void mediaPermsCallback(PluginCall call) {
        call.resolve(statusObject());
    }

    @PluginMethod
    public void requestAllFiles(PluginCall call) {
        if (Build.VERSION.SDK_INT < 30) {
            requestMedia(call);
            return;
        }
        if (Environment.isExternalStorageManager()) {
            call.resolve(statusObject());
            return;
        }
        try {
            Intent i = new Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName())
            );
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception first) {
            try {
                Intent i2 = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                i2.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i2);
            } catch (Exception second) {
                call.reject("Could not open the All files access settings page.");
                return;
            }
        }
        call.resolve(statusObject());
    }

    /* ------------------------------------------------------------------ */
    /* Volumes                                                             */
    /* ------------------------------------------------------------------ */

    private JSObject volume(String name, File f, boolean primary) {
        JSObject o = new JSObject();
        o.put("name", name);
        o.put("path", f.getAbsolutePath());
        o.put("primary", primary);
        long total = 0;
        long free = 0;
        try {
            StatFs s = new StatFs(f.getAbsolutePath());
            total = s.getTotalBytes();
            free = s.getAvailableBytes();
        } catch (Exception ignored) {
        }
        o.put("total", total);
        o.put("free", free);
        return o;
    }

    @PluginMethod
    public void roots(PluginCall call) {
        try {
            JSArray vols = new JSArray();
            File prim = Environment.getExternalStorageDirectory();
            vols.put(volume("Internal storage", prim, true));

            File[] dirs = getContext().getExternalFilesDirs(null);
            if (dirs != null) {
                for (File d : dirs) {
                    if (d == null) continue;
                    String p = d.getAbsolutePath();
                    int k = p.indexOf("/Android/");
                    if (k <= 0) continue;
                    String root = p.substring(0, k);
                    if (root.equals(prim.getAbsolutePath()) || root.startsWith("/storage/emulated/")) continue;
                    File rf = new File(root);
                    if (!rf.exists() || !rf.canRead()) continue;
                    String label = "SD card";
                    try {
                        if (!Environment.isExternalStorageRemovable(d)) label = "Storage";
                    } catch (Exception ignored) {
                    }
                    vols.put(volume(label, rf, false));
                }
            }

            JSArray shorts = new JSArray();
            String[][] known = {
                { "Download", "Downloads" },
                { "DCIM", "Camera" },
                { "Pictures", "Pictures" },
                { "Movies", "Movies" },
                { "Music", "Music" },
                { "Documents", "Documents" }
            };
            for (String[] s : known) {
                File f = new File(prim, s[0]);
                if (f.isDirectory()) {
                    JSObject o = new JSObject();
                    o.put("name", s[1]);
                    o.put("path", f.getAbsolutePath());
                    shorts.put(o);
                }
            }

            JSObject r = new JSObject();
            r.put("volumes", vols);
            r.put("shortcuts", shorts);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read the storage volumes.");
        }
    }

    /* ------------------------------------------------------------------ */
    /* Listing and search                                                  */
    /* ------------------------------------------------------------------ */

    private JSObject entry(File f) {
        boolean dir = f.isDirectory();
        JSObject o = new JSObject();
        o.put("name", f.getName());
        o.put("path", f.getAbsolutePath());
        o.put("dir", dir);
        o.put("size", dir ? 0L : f.length());
        o.put("modified", f.lastModified());
        return o;
    }

    private boolean isSymlink(File f) {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                return java.nio.file.Files.isSymbolicLink(f.toPath());
            } catch (Exception e) {
                return false;
            }
        }
        try {
            File parent = f.getParentFile();
            if (parent == null) return false;
            File canon = new File(parent.getCanonicalFile(), f.getName());
            return !canon.getCanonicalFile().equals(canon.getAbsoluteFile());
        } catch (IOException e) {
            return false;
        }
    }

    @PluginMethod
    public void list(final PluginCall call) {
        final String path = call.getString("path");
        final boolean hidden = Boolean.TRUE.equals(call.getBoolean("hidden", false));
        pool.execute(() -> {
            try {
                if (path == null) {
                    call.reject("Missing path.");
                    return;
                }
                File dir = new File(path);
                if (!dir.exists()) {
                    call.reject("This folder no longer exists.");
                    return;
                }
                if (!dir.isDirectory()) {
                    call.reject("This is not a folder.");
                    return;
                }
                File[] fs = dir.listFiles();
                if (fs == null) {
                    call.reject("Android did not allow reading this folder.");
                    return;
                }
                JSArray arr = new JSArray();
                for (File f : fs) {
                    if (!hidden && f.getName().startsWith(".")) continue;
                    arr.put(entry(f));
                }
                JSObject r = new JSObject();
                r.put("path", dir.getAbsolutePath());
                r.put("entries", arr);
                r.put("writable", dir.canWrite());
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not read this folder.");
            }
        });
    }

    @PluginMethod
    public void search(final PluginCall call) {
        final String path = call.getString("path");
        final String q = call.getString("query");
        final boolean hidden = Boolean.TRUE.equals(call.getBoolean("hidden", false));
        final int limit = call.getInt("limit", 300);
        final long id = call.getInt("id", 0);
        pool.execute(() -> {
            LATEST_SEARCH.set(id);
            JSArray arr = new JSArray();
            boolean partial = false;
            try {
                if (path != null && q != null && !q.trim().isEmpty()) {
                    final String needle = q.trim().toLowerCase(Locale.ROOT);
                    ArrayDeque<File> queue = new ArrayDeque<>();
                    queue.add(new File(path));
                    long end = System.currentTimeMillis() + 10000;
                    int visited = 0;
                    outer:
                    while (!queue.isEmpty()) {
                        if (LATEST_SEARCH.get() != id) {
                            partial = true;
                            break;
                        }
                        if (System.currentTimeMillis() > end || visited > 200000) {
                            partial = true;
                            break;
                        }
                        File d = queue.poll();
                        File[] fs = d.listFiles();
                        if (fs == null) continue;
                        for (File f : fs) {
                            visited++;
                            String n = f.getName();
                            if (!hidden && n.startsWith(".")) continue;
                            if (n.toLowerCase(Locale.ROOT).contains(needle)) {
                                arr.put(entry(f));
                                if (arr.length() >= limit) {
                                    partial = true;
                                    break outer;
                                }
                            }
                            if (f.isDirectory() && !isSymlink(f)) queue.add(f);
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            JSObject r = new JSObject();
            r.put("entries", arr);
            r.put("partial", partial);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void folderInfo(final PluginCall call) {
        final String path = call.getString("path");
        pool.execute(() -> {
            long files = 0;
            long folders = 0;
            long bytes = 0;
            boolean partial = false;
            try {
                if (path == null) {
                    call.reject("Missing path.");
                    return;
                }
                ArrayDeque<File> stack = new ArrayDeque<>();
                stack.add(new File(path));
                long end = System.currentTimeMillis() + 4000;
                int visited = 0;
                while (!stack.isEmpty()) {
                    if (System.currentTimeMillis() > end || visited > 100000) {
                        partial = true;
                        break;
                    }
                    File d = stack.poll();
                    File[] fs = d.listFiles();
                    if (fs == null) continue;
                    for (File f : fs) {
                        visited++;
                        if (f.isDirectory()) {
                            if (!isSymlink(f)) {
                                folders++;
                                stack.add(f);
                            }
                        } else {
                            files++;
                            bytes += f.length();
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            JSObject r = new JSObject();
            r.put("files", files);
            r.put("folders", folders);
            r.put("bytes", bytes);
            r.put("partial", partial);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void readText(final PluginCall call) {
        final String path = call.getString("path");
        int requested = call.getInt("max", 16384);
        final int max = Math.max(1, Math.min(requested, 200000));
        pool.execute(() -> {
            if (path == null) {
                call.reject("Missing path.");
                return;
            }
            File f = new File(path);
            if (!f.isFile()) {
                call.reject("File not found.");
                return;
            }
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[max + 1];
                int total = 0;
                int n;
                while (total < buf.length && (n = in.read(buf, total, buf.length - total)) > 0) {
                    total += n;
                }
                boolean truncated = total > max;
                int len = Math.min(total, max);
                boolean binary = false;
                int probe = Math.min(len, 2000);
                for (int i = 0; i < probe; i++) {
                    if (buf[i] == 0) {
                        binary = true;
                        break;
                    }
                }
                JSObject r = new JSObject();
                r.put("binary", binary);
                r.put("truncated", truncated);
                r.put("text", binary ? "" : new String(buf, 0, len, StandardCharsets.UTF_8));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not read this file.");
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Changing files                                                      */
    /* ------------------------------------------------------------------ */

    private List<String> strings(PluginCall call, String key) {
        List<String> out = new ArrayList<>();
        JSArray a = call.getArray(key);
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            try {
                String s = a.getString(i);
                if (s != null) out.add(s);
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    /** Refuses to touch the filesystem root, /storage and the storage volume roots themselves. */
    private boolean isProtected(File f) {
        File parent = f.getParentFile();
        if (parent == null) return true;
        String p = parent.getAbsolutePath();
        return p.equals("/") || p.equals("/storage") || p.equals("/storage/emulated");
    }

    private boolean deleteRecursive(File f) {
        if (f.isDirectory() && !isSymlink(f)) {
            File[] kids = f.listFiles();
            if (kids != null) {
                for (File k : kids) deleteRecursive(k);
            }
        }
        return f.delete();
    }

    private void copyRecursive(File src, File dst) throws IOException {
        if (src.isDirectory()) {
            if (!dst.exists() && !dst.mkdirs()) throw new IOException("could not create folder");
            File[] kids = src.listFiles();
            if (kids != null) {
                for (File k : kids) copyRecursive(k, new File(dst, k.getName()));
            }
            dst.setLastModified(src.lastModified());
        } else {
            try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
            dst.setLastModified(src.lastModified());
        }
    }

    private File uniqueTarget(File dir, String name) {
        File t = new File(dir, name);
        if (!t.exists()) return t;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 10000; i++) {
            t = new File(dir, base + " (" + i + ")" + ext);
            if (!t.exists()) return t;
        }
        return new File(dir, base + " (" + System.currentTimeMillis() + ")" + ext);
    }

    private boolean sameOrInside(File child, File ancestor) {
        try {
            String c = child.getCanonicalPath();
            String a = ancestor.getCanonicalPath();
            return c.equals(a) || c.startsWith(a + File.separator);
        } catch (IOException e) {
            return false;
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        String p = call.getString("path");
        if (p == null) {
            call.reject("Missing path.");
            return;
        }
        File f = new File(p);
        if (f.exists()) {
            call.reject("A file or folder with that name already exists here.");
            return;
        }
        if (f.mkdirs()) {
            call.resolve();
        } else {
            call.reject("Could not create the folder. Check that this location is writable.");
        }
    }

    @PluginMethod
    public void rename(PluginCall call) {
        String from = call.getString("from");
        String to = call.getString("to");
        if (from == null || to == null) {
            call.reject("Missing path.");
            return;
        }
        File a = new File(from);
        File b = new File(to);
        if (isProtected(a)) {
            call.reject("This location cannot be renamed.");
            return;
        }
        if (b.exists()) {
            call.reject("A file or folder with that name already exists here.");
            return;
        }
        if (a.renameTo(b)) {
            call.resolve();
        } else {
            call.reject("Could not rename. Check that this location is writable.");
        }
    }

    @PluginMethod
    public void delete(final PluginCall call) {
        final List<String> paths = strings(call, "paths");
        pool.execute(() -> {
            JSArray failed = new JSArray();
            for (String p : paths) {
                File f = new File(p);
                if (!f.exists()) continue;
                if (isProtected(f) || !deleteRecursive(f)) failed.put(f.getName());
            }
            JSObject r = new JSObject();
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void paste(final PluginCall call) {
        final List<String> paths = strings(call, "paths");
        final String dest = call.getString("dest");
        final boolean move = "move".equals(call.getString("mode"));
        pool.execute(() -> {
            File dd = dest == null ? null : new File(dest);
            if (dd == null || !dd.isDirectory()) {
                call.reject("The destination folder is not available.");
                return;
            }
            int done = 0;
            JSArray failed = new JSArray();
            for (String p : paths) {
                File src = new File(p);
                String nm = src.getName();
                try {
                    if (!src.exists()) {
                        failed.put(nm + " (missing)");
                        continue;
                    }
                    if (src.isDirectory() && sameOrInside(dd, src)) {
                        failed.put(nm + " (cannot go inside itself)");
                        continue;
                    }
                    if (move) {
                        if (isProtected(src)) {
                            failed.put(nm + " (protected)");
                            continue;
                        }
                        File sp = src.getParentFile();
                        if (sp != null && sp.getAbsolutePath().equals(dd.getAbsolutePath())) {
                            done++;
                            continue;
                        }
                        File t = uniqueTarget(dd, nm);
                        if (!src.renameTo(t)) {
                            copyRecursive(src, t);
                            if (!deleteRecursive(src)) {
                                failed.put(nm + " (copied, original not removed)");
                                continue;
                            }
                        }
                        done++;
                    } else {
                        copyRecursive(src, uniqueTarget(dd, nm));
                        done++;
                    }
                } catch (Exception e) {
                    failed.put(nm + " (" + (e.getMessage() == null ? "error" : e.getMessage()) + ")");
                }
            }
            JSObject r = new JSObject();
            r.put("done", done);
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Open and share                                                      */
    /* ------------------------------------------------------------------ */

    private String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (m != null) return m;
        }
        return "*/*";
    }

    private Uri uriFor(File f) {
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
    }

    private void launch(Intent chooser) {
        if (getActivity() != null) {
            getActivity().startActivity(chooser);
        } else {
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
        }
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String p = call.getString("path");
        File f = p == null ? null : new File(p);
        if (f == null || !f.isFile()) {
            call.reject("File not found.");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uriFor(f), mimeOf(f.getName()));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(i, "Open with");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            launch(chooser);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this device can open this type of file.");
        } catch (Exception e) {
            call.reject("Could not open this file.");
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        List<String> paths = strings(call, "paths");
        ArrayList<Uri> uris = new ArrayList<>();
        String mime = null;
        try {
            for (String p : paths) {
                File f = new File(p);
                if (!f.isFile()) continue;
                uris.add(uriFor(f));
                String m = mimeOf(f.getName());
                mime = (mime == null || mime.equals(m)) ? m : "*/*";
            }
            if (uris.isEmpty()) {
                call.reject("Nothing to share.");
                return;
            }
            Intent i;
            if (uris.size() == 1) {
                i = new Intent(Intent.ACTION_SEND);
                i.setType(mime);
                i.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                i = new Intent(Intent.ACTION_SEND_MULTIPLE);
                i.setType(mime == null ? "*/*" : mime);
                i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(i, "Share");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            launch(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not share these files.");
        }
    }
}
