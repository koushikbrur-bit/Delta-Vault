package com.deltavault.files;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.provider.Settings;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;
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

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Native file access for Delta Vault 2.0.
 *
 * Original features: runtime permissions, "All files access" flow, listing, search, copy / move /
 * rename / delete, text preview, open and share.
 *
 * New in 2.0:
 *  - Recycle bin: deleted items are moved to a hidden folder at the root of the same storage
 *    volume and can be restored for 30 days.
 *  - Private locker: files are moved into the app's own private storage (not reachable by other
 *    apps or over USB) and guarded by a PIN.
 *  - Background jobs: storage scan (sizes by folder, by category, biggest files) and duplicate
 *    finder, polled by the web layer through jobStatus.
 *
 * All heavy work runs on a private thread pool so slow folders never block the UI.
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

    private static final String BIN_NAME = ".DeltaVaultBin";
    private static final long BIN_MAX_AGE_MS = 30L * 24L * 3600L * 1000L;
    private static final Pattern ID_RE = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
    private static final Pattern PIN_RE = Pattern.compile("^[0-9]{4,8}$");
    private static final String INDEX_NAME = ".dv_index.json";

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private static final AtomicLong LATEST_SEARCH = new AtomicLong(0);

    private volatile boolean lockerOpen = false;
    private final Object lockerLock = new Object();

    /* ------------------------------------------------------------------ */
    /* Small shared helpers                                                */
    /* ------------------------------------------------------------------ */

    private static String msg(Exception e) {
        String m = e.getMessage();
        return (m == null || m.isEmpty()) ? "error" : m;
    }

    private boolean has(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

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

    private void mediaScan(List<String> paths) {
        try {
            if (paths == null || paths.isEmpty()) return;
            int n = Math.min(paths.size(), 300);
            String[] arr = new String[n];
            for (int i = 0; i < n; i++) arr[i] = paths.get(i);
            MediaScannerConnection.scanFile(getContext(), arr, null, null);
        } catch (Throwable ignored) {
        }
    }

    /** Files under f (or f itself), capped, for telling the gallery about changes. */
    private List<String> filesUnder(File f, int cap) {
        List<String> out = new ArrayList<>();
        ArrayDeque<File> stack = new ArrayDeque<>();
        stack.push(f);
        while (!stack.isEmpty() && out.size() < cap) {
            File d = stack.pop();
            if (d.isDirectory()) {
                if (isSymlink(d)) continue;
                File[] kids = d.listFiles();
                if (kids != null) {
                    for (File k : kids) stack.push(k);
                }
            } else {
                out.add(d.getAbsolutePath());
            }
        }
        return out;
    }

    private void writeText(File f, String s) throws IOException {
        try (OutputStream o = new FileOutputStream(f)) {
            o.write(s.getBytes(StandardCharsets.UTF_8));
        }
    }

    private String readSmall(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int total = 0;
            int n;
            while (total < buf.length && (n = in.read(buf, total, buf.length - total)) > 0) {
                total += n;
            }
            return new String(buf, 0, total, StandardCharsets.UTF_8);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Access                                                              */
    /* ------------------------------------------------------------------ */

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

    /** Auto-lock the private locker whenever the app leaves the foreground. */
    @Override
    protected void handleOnPause() {
        lockerOpen = false;
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

    private List<File> volumeRoots() {
        List<File> out = new ArrayList<>();
        File prim = Environment.getExternalStorageDirectory();
        out.add(prim);
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
                boolean dup = false;
                for (File x : out) {
                    if (x.getAbsolutePath().equals(root)) dup = true;
                }
                if (!dup) out.add(rf);
            }
        }
        return out;
    }

    private File volumeRootOf(File f) {
        String p = f.getAbsolutePath();
        for (File r : volumeRoots()) {
            String rp = r.getAbsolutePath();
            if (p.equals(rp) || p.startsWith(rp + "/")) return r;
        }
        return null;
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
                    String n = f.getName();
                    if (n.equals(BIN_NAME)) continue;
                    if (!hidden && n.startsWith(".")) continue;
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
                            if (n.equals(BIN_NAME)) continue;
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
                for (File k : kids) {
                    if (k.isDirectory() && isSymlink(k)) continue;
                    copyRecursive(k, new File(dst, k.getName()));
                }
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
            if (dst.length() != src.length()) {
                throw new IOException("copy was incomplete");
            }
            dst.setLastModified(src.lastModified());
        }
    }

    /** Copy that cleans up its own partial output if it fails. */
    private void copyTree(File src, File dst) throws IOException {
        try {
            copyRecursive(src, dst);
        } catch (IOException e) {
            deleteRecursive(dst);
            throw e;
        }
    }

    /** Move: rename if possible, otherwise copy and then remove the source. Never removes the source before the copy succeeded. */
    private void moveTree(File src, File dst) throws IOException {
        if (src.renameTo(dst)) return;
        copyTree(src, dst);
        if (!deleteRecursive(src)) {
            throw new IOException("copied, but the original could not be removed");
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

    private long treeSize(File start, long budgetMs) {
        long total = 0;
        long end = System.currentTimeMillis() + budgetMs;
        ArrayDeque<File> stack = new ArrayDeque<>();
        stack.push(start);
        while (!stack.isEmpty()) {
            if (System.currentTimeMillis() > end) break;
            File d = stack.pop();
            if (d.isDirectory()) {
                if (isSymlink(d)) continue;
                File[] kids = d.listFiles();
                if (kids != null) {
                    for (File k : kids) stack.push(k);
                }
            } else {
                total += d.length();
            }
        }
        return total;
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
            List<String> sc = new ArrayList<>();
            sc.add(from);
            sc.addAll(filesUnder(b, 100));
            mediaScan(sc);
            call.resolve();
        } else {
            call.reject("Could not rename. Check that this location is writable.");
        }
    }

    /** Permanent delete (no recycle bin). */
    @PluginMethod
    public void delete(final PluginCall call) {
        final List<String> paths = strings(call, "paths");
        pool.execute(() -> {
            JSArray failed = new JSArray();
            List<String> gone = new ArrayList<>();
            for (String p : paths) {
                File f = new File(p);
                if (!f.exists()) continue;
                gone.addAll(filesUnder(f, 100));
                if (isProtected(f) || !deleteRecursive(f)) failed.put(f.getName());
            }
            mediaScan(gone);
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
            List<String> touched = new ArrayList<>();
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
                        touched.addAll(filesUnder(src, 100));
                        File t = uniqueTarget(dd, nm);
                        moveTree(src, t);
                        touched.addAll(filesUnder(t, 100));
                        done++;
                    } else {
                        File t = uniqueTarget(dd, nm);
                        copyTree(src, t);
                        touched.addAll(filesUnder(t, 100));
                        done++;
                    }
                } catch (Exception e) {
                    failed.put(nm + " (" + msg(e) + ")");
                }
            }
            mediaScan(touched);
            JSObject r = new JSObject();
            r.put("done", done);
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Recycle bin                                                         */
    /* ------------------------------------------------------------------ */

    private void ensureBin(File bin) throws IOException {
        if (!bin.isDirectory() && !bin.mkdirs()) throw new IOException("bin not writable");
        File nm = new File(bin, ".nomedia");
        if (!nm.exists()) {
            try {
                nm.createNewFile();
            } catch (IOException ignored) {
            }
        }
    }

    private void writeMeta(File bin, String id, String name, String origin, boolean dir, long size) {
        try {
            JSONObject m = new JSONObject();
            m.put("name", name);
            m.put("origin", origin);
            m.put("dir", dir);
            m.put("size", size);
            m.put("deleted", System.currentTimeMillis());
            writeText(new File(bin, id + ".json"), m.toString());
        } catch (Exception ignored) {
            // Without metadata the item still shows up in the bin under its id, so nothing is lost.
        }
    }

    private JSObject binEntry(File bin, File item, File root) {
        String id = item.getName();
        String name = id;
        String origin = "";
        boolean dir = item.isDirectory();
        long size = dir ? 0L : item.length();
        long deleted = item.lastModified();
        File metaFile = new File(bin, id + ".json");
        if (metaFile.isFile()) {
            try {
                JSONObject m = new JSONObject(readSmall(metaFile));
                name = m.optString("name", id);
                origin = m.optString("origin", "");
                dir = m.optBoolean("dir", dir);
                size = m.optLong("size", size);
                deleted = m.optLong("deleted", deleted);
            } catch (Exception ignored) {
            }
        }
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("name", name);
        o.put("origin", origin);
        o.put("dir", dir);
        o.put("size", size);
        o.put("deleted", deleted);
        o.put("root", root.getAbsolutePath());
        return o;
    }

    private void purgeItem(File bin, String id) {
        deleteRecursive(new File(bin, id));
        new File(bin, id + ".json").delete();
    }

    @PluginMethod
    public void trashMove(final PluginCall call) {
        final List<String> paths = strings(call, "paths");
        pool.execute(() -> {
            int done = 0;
            JSArray failed = new JSArray();
            List<String> gone = new ArrayList<>();
            for (String p : paths) {
                File src = new File(p);
                String nm = src.getName();
                try {
                    if (!src.exists()) {
                        failed.put(nm + " (missing)");
                        continue;
                    }
                    if (isProtected(src)) {
                        failed.put(nm + " (protected)");
                        continue;
                    }
                    File root = volumeRootOf(src);
                    if (root == null) {
                        failed.put(nm + " (the recycle bin is not available here)");
                        continue;
                    }
                    File bin = new File(root, BIN_NAME);
                    if (sameOrInside(src, bin)) {
                        failed.put(nm + " (already in the bin)");
                        continue;
                    }
                    ensureBin(bin);
                    String id = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
                    File dst = new File(bin, id);
                    boolean dir = src.isDirectory();
                    long size = dir ? treeSize(src, 2500) : src.length();
                    gone.addAll(filesUnder(src, 100));
                    moveTree(src, dst);
                    writeMeta(bin, id, nm, src.getAbsolutePath(), dir, size);
                    done++;
                } catch (Exception e) {
                    failed.put(nm + " (" + msg(e) + ")");
                }
            }
            mediaScan(gone);
            JSObject r = new JSObject();
            r.put("done", done);
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void trashList(final PluginCall call) {
        pool.execute(() -> {
            try {
                JSArray arr = new JSArray();
                int purged = 0;
                long now = System.currentTimeMillis();
                for (File root : volumeRoots()) {
                    File bin = new File(root, BIN_NAME);
                    File[] kids = bin.listFiles();
                    if (kids == null) continue;
                    for (File k : kids) {
                        String n = k.getName();
                        if (!ID_RE.matcher(n).matches()) continue;
                        JSObject e = binEntry(bin, k, root);
                        long del = e.optLong("deleted", now);
                        if (now - del > BIN_MAX_AGE_MS) {
                            purgeItem(bin, n);
                            purged++;
                            continue;
                        }
                        arr.put(e);
                    }
                }
                JSObject r = new JSObject();
                r.put("entries", arr);
                r.put("purged", purged);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not read the recycle bin.");
            }
        });
    }

    @PluginMethod
    public void trashRestore(final PluginCall call) {
        final List<String> ids = strings(call, "ids");
        pool.execute(() -> {
            int done = 0;
            JSArray failed = new JSArray();
            List<String> added = new ArrayList<>();
            for (String id : ids) {
                if (!ID_RE.matcher(id).matches()) {
                    failed.put("invalid item");
                    continue;
                }
                File bin = null;
                File item = null;
                File root = null;
                for (File r : volumeRoots()) {
                    File b = new File(r, BIN_NAME);
                    File it = new File(b, id);
                    if (it.exists()) {
                        bin = b;
                        item = it;
                        root = r;
                        break;
                    }
                }
                if (item == null) {
                    failed.put(id + " (not found)");
                    continue;
                }
                JSObject e = binEntry(bin, item, root);
                String name = e.optString("name", id);
                try {
                    String origin = e.optString("origin", "");
                    File parent = origin.isEmpty() ? null : new File(origin).getParentFile();
                    if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
                        parent = new File(root, "Restored");
                        if (!parent.isDirectory() && !parent.mkdirs()) {
                            throw new IOException("could not create the destination folder");
                        }
                    }
                    File target = uniqueTarget(parent, name);
                    moveTree(item, target);
                    new File(bin, id + ".json").delete();
                    added.addAll(filesUnder(target, 100));
                    done++;
                } catch (Exception ex) {
                    failed.put(name + " (" + msg(ex) + ")");
                }
            }
            mediaScan(added);
            JSObject r = new JSObject();
            r.put("done", done);
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void trashDelete(final PluginCall call) {
        final List<String> ids = strings(call, "ids");
        pool.execute(() -> {
            int done = 0;
            for (String id : ids) {
                if (!ID_RE.matcher(id).matches()) continue;
                for (File r : volumeRoots()) {
                    File b = new File(r, BIN_NAME);
                    if (new File(b, id).exists()) {
                        purgeItem(b, id);
                        done++;
                        break;
                    }
                }
            }
            JSObject r = new JSObject();
            r.put("done", done);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void trashEmpty(final PluginCall call) {
        pool.execute(() -> {
            int done = 0;
            for (File root : volumeRoots()) {
                File bin = new File(root, BIN_NAME);
                File[] kids = bin.listFiles();
                if (kids == null) continue;
                for (File k : kids) {
                    String n = k.getName();
                    if (n.equals(".nomedia")) continue;
                    if (deleteRecursive(k)) done++;
                }
            }
            JSObject r = new JSObject();
            r.put("done", done);
            call.resolve(r);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Private locker                                                      */
    /* ------------------------------------------------------------------ */

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("dv_locker", Context.MODE_PRIVATE);
    }

    private File lockerRoot() {
        File d = new File(getContext().getFilesDir(), "locker");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** Resolves a path relative to the locker and refuses anything that escapes it. */
    private File lockerFile(String rel) throws IOException {
        File root = lockerRoot();
        File f = (rel == null || rel.isEmpty()) ? root : new File(root, rel);
        String rc = root.getCanonicalPath();
        String fc = f.getCanonicalPath();
        if (!fc.equals(rc) && !fc.startsWith(rc + File.separator)) {
            throw new IOException("Invalid locker path.");
        }
        return f;
    }

    private boolean pinIsSet() {
        SharedPreferences p = prefs();
        return p.getString("salt", null) != null && p.getString("hash", null) != null;
    }

    private long lockedFor() {
        long until = prefs().getLong("lockUntil", 0L);
        long now = System.currentTimeMillis();
        return until > now ? until - now : 0L;
    }

    private JSObject pinState() {
        JSObject o = new JSObject();
        o.put("set", pinIsSet());
        o.put("open", lockerOpen);
        o.put("lockedFor", lockedFor());
        return o;
    }

    private byte[] pbkdf2(String pin, byte[] salt) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, 20000, 256);
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(spec).getEncoded();
    }

    private synchronized JSObject checkPin(String pin) {
        JSObject r = new JSObject();
        long lf = lockedFor();
        if (lf > 0) {
            r.put("ok", false);
            r.put("lockedFor", lf);
            r.put("attemptsLeft", 0);
            return r;
        }
        boolean ok = false;
        try {
            SharedPreferences p = prefs();
            String s = p.getString("salt", null);
            String h = p.getString("hash", null);
            if (s != null && h != null && pin != null) {
                byte[] calc = pbkdf2(pin, Base64.decode(s, Base64.NO_WRAP));
                ok = MessageDigest.isEqual(calc, Base64.decode(h, Base64.NO_WRAP));
            }
        } catch (Exception ignored) {
        }
        SharedPreferences.Editor ed = prefs().edit();
        int fails = prefs().getInt("fails", 0);
        if (ok) {
            fails = 0;
            ed.putInt("fails", 0);
            ed.putLong("lockUntil", 0L);
        } else {
            fails = fails + 1;
            ed.putInt("fails", fails);
            if (fails >= 5) {
                long delay = Math.min(900000L, 30000L * (1L << Math.min(10, fails - 5)));
                ed.putLong("lockUntil", System.currentTimeMillis() + delay);
            }
        }
        ed.apply();
        r.put("ok", ok);
        r.put("attemptsLeft", ok ? 5 : Math.max(0, 5 - fails));
        r.put("lockedFor", ok ? 0L : lockedFor());
        return r;
    }

    private void storePin(String pin) throws Exception {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        byte[] h = pbkdf2(pin, salt);
        prefs().edit()
            .putString("salt", Base64.encodeToString(salt, Base64.NO_WRAP))
            .putString("hash", Base64.encodeToString(h, Base64.NO_WRAP))
            .putInt("fails", 0)
            .putLong("lockUntil", 0L)
            .apply();
    }

    @PluginMethod
    public void pinStatus(PluginCall call) {
        call.resolve(pinState());
    }

    @PluginMethod
    public void pinSet(PluginCall call) {
        String pin = call.getString("pin", "");
        if (pin == null || !PIN_RE.matcher(pin).matches()) {
            call.reject("Use 4 to 8 digits.");
            return;
        }
        if (pinIsSet()) {
            call.reject("A PIN already exists.");
            return;
        }
        try {
            storePin(pin);
            lockerRoot();
            lockerOpen = true;
            call.resolve(pinState());
        } catch (Exception e) {
            call.reject("Could not save the PIN.");
        }
    }

    @PluginMethod
    public void pinVerify(PluginCall call) {
        if (!pinIsSet()) {
            call.reject("No PIN has been set.");
            return;
        }
        JSObject r = checkPin(call.getString("pin", ""));
        if (r.optBoolean("ok", false)) lockerOpen = true;
        call.resolve(r);
    }

    @PluginMethod
    public void pinChange(PluginCall call) {
        String next = call.getString("pin", "");
        if (next == null || !PIN_RE.matcher(next).matches()) {
            call.reject("Use 4 to 8 digits.");
            return;
        }
        JSObject r = checkPin(call.getString("old", ""));
        if (!r.optBoolean("ok", false)) {
            call.resolve(r);
            return;
        }
        try {
            storePin(next);
            lockerOpen = true;
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not save the new PIN.");
        }
    }

    @PluginMethod
    public void lock(PluginCall call) {
        lockerOpen = false;
        call.resolve(pinState());
    }

    /** Hides the app from screenshots and the recent-apps screen while the locker is showing. */
    @PluginMethod
    public void setSecure(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        final Activity act = getActivity();
        if (act != null) {
            act.runOnUiThread(() -> {
                Window w = act.getWindow();
                if (on) {
                    w.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                } else {
                    w.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                }
            });
        }
        call.resolve();
    }

    private JSONObject readIndex() {
        synchronized (lockerLock) {
            try {
                File f = new File(lockerRoot(), INDEX_NAME);
                if (f.isFile()) return new JSONObject(readSmall(f));
            } catch (Exception ignored) {
            }
            return new JSONObject();
        }
    }

    private void writeIndex(JSONObject idx) {
        synchronized (lockerLock) {
            try {
                writeText(new File(lockerRoot(), INDEX_NAME), idx.toString());
            } catch (Exception ignored) {
            }
        }
    }

    private void indexPut(String name, String origin) {
        synchronized (lockerLock) {
            try {
                JSONObject idx = readIndex();
                idx.put(name, origin);
                writeIndex(idx);
            } catch (Exception ignored) {
            }
        }
    }

    private void indexRemove(String name) {
        synchronized (lockerLock) {
            JSONObject idx = readIndex();
            idx.remove(name);
            writeIndex(idx);
        }
    }

    @PluginMethod
    public void lockerList(final PluginCall call) {
        if (!lockerOpen) {
            call.reject("The locker is locked.");
            return;
        }
        final String rel = call.getString("path", "");
        pool.execute(() -> {
            try {
                String r0 = rel == null ? "" : rel;
                File dir = lockerFile(r0);
                File[] fs = dir.listFiles();
                if (fs == null) {
                    call.reject("Could not read the locker.");
                    return;
                }
                JSONObject idx = readIndex();
                JSArray arr = new JSArray();
                for (File f : fs) {
                    String n = f.getName();
                    if (n.startsWith(".dv_")) continue;
                    JSObject o = entry(f);
                    o.put("rel", r0.isEmpty() ? n : r0 + "/" + n);
                    if (r0.isEmpty()) o.put("origin", idx.optString(n, ""));
                    arr.put(o);
                }
                JSObject res = new JSObject();
                res.put("entries", arr);
                res.put("path", r0);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Could not read the locker.");
            }
        });
    }

    @PluginMethod
    public void lockerAdd(final PluginCall call) {
        if (!lockerOpen) {
            call.reject("The locker is locked.");
            return;
        }
        final List<String> paths = strings(call, "paths");
        pool.execute(() -> {
            int done = 0;
            JSArray failed = new JSArray();
            List<String> gone = new ArrayList<>();
            File root = lockerRoot();
            for (String p : paths) {
                File src = new File(p);
                String nm = src.getName();
                try {
                    if (!src.exists()) {
                        failed.put(nm + " (missing)");
                        continue;
                    }
                    if (isProtected(src)) {
                        failed.put(nm + " (protected)");
                        continue;
                    }
                    if (sameOrInside(src, root) || sameOrInside(root, src)) {
                        failed.put(nm + " (already in the locker)");
                        continue;
                    }
                    File dst = uniqueTarget(root, nm);
                    List<String> before = filesUnder(src, 100);
                    String origin = src.getAbsolutePath();
                    copyTree(src, dst);
                    indexPut(dst.getName(), origin);
                    if (!deleteRecursive(src)) {
                        // The copy is complete and kept, so nothing is lost; tell the user plainly.
                        failed.put(nm + " (locked, but the original could not be removed)");
                    } else {
                        done++;
                    }
                    gone.addAll(before);
                } catch (Exception e) {
                    failed.put(nm + " (" + msg(e) + ")");
                }
            }
            mediaScan(gone);
            JSObject r = new JSObject();
            r.put("done", done);
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void lockerRestore(final PluginCall call) {
        if (!lockerOpen) {
            call.reject("The locker is locked.");
            return;
        }
        final List<String> rels = strings(call, "paths");
        pool.execute(() -> {
            int done = 0;
            JSArray failed = new JSArray();
            List<String> added = new ArrayList<>();
            JSONObject idx = readIndex();
            File fallback = new File(Environment.getExternalStorageDirectory(), "Download");
            for (String rel : rels) {
                String nm = rel;
                try {
                    File src = lockerFile(rel);
                    nm = src.getName();
                    if (!src.exists()) {
                        failed.put(nm + " (missing)");
                        continue;
                    }
                    File dest = fallback;
                    boolean top = !rel.contains("/");
                    if (top) {
                        String origin = idx.optString(nm, "");
                        File parent = origin.isEmpty() ? null : new File(origin).getParentFile();
                        if (parent != null && (parent.isDirectory() || parent.mkdirs())) dest = parent;
                    }
                    if (!dest.isDirectory() && !dest.mkdirs()) {
                        throw new IOException("could not create the destination folder");
                    }
                    File target = uniqueTarget(dest, nm);
                    moveTree(src, target);
                    if (top) indexRemove(nm);
                    added.addAll(filesUnder(target, 100));
                    done++;
                } catch (Exception e) {
                    failed.put(nm + " (" + msg(e) + ")");
                }
            }
            mediaScan(added);
            JSObject r = new JSObject();
            r.put("done", done);
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void lockerDelete(final PluginCall call) {
        if (!lockerOpen) {
            call.reject("The locker is locked.");
            return;
        }
        final List<String> rels = strings(call, "paths");
        pool.execute(() -> {
            int done = 0;
            JSArray failed = new JSArray();
            for (String rel : rels) {
                try {
                    File f = lockerFile(rel);
                    if (f.equals(lockerRoot())) continue;
                    if (deleteRecursive(f)) {
                        if (!rel.contains("/")) indexRemove(f.getName());
                        done++;
                    } else {
                        failed.put(f.getName());
                    }
                } catch (Exception e) {
                    failed.put(rel);
                }
            }
            JSObject r = new JSObject();
            r.put("done", done);
            r.put("failed", failed);
            call.resolve(r);
        });
    }

    /** Forgot the PIN: wipes everything in the locker and clears the PIN. Requires confirm = "ERASE". */
    @PluginMethod
    public void lockerReset(final PluginCall call) {
        if (!"ERASE".equals(call.getString("confirm", ""))) {
            call.reject("Confirmation missing.");
            return;
        }
        pool.execute(() -> {
            try {
                lockerOpen = false;
                File root = lockerRoot();
                File[] kids = root.listFiles();
                if (kids != null) {
                    for (File k : kids) deleteRecursive(k);
                }
                prefs().edit().clear().apply();
                call.resolve(pinState());
            } catch (Exception e) {
                call.reject("Could not erase the locker.");
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Background jobs: storage scan and duplicate finder                  */
    /* ------------------------------------------------------------------ */

    private static class Job {
        volatile boolean done;
        volatile boolean cancelled;
        volatile boolean partial;
        volatile long files;
        volatile long bytes;
        volatile long total;
        volatile String stage = "starting";
        volatile JSObject result;
        volatile String error;
    }

    private static class Big {
        final String path;
        final long size;
        final long mod;

        Big(String path, long size, long mod) {
            this.path = path;
            this.size = size;
            this.mod = mod;
        }
    }

    private static class Kid {
        String name;
        String path;
        boolean dir;
        long size;
        long files;
        int cat;
    }

    private static class Group {
        long size;
        List<String> files;
    }

    private final ConcurrentHashMap<String, Job> jobs = new ConcurrentHashMap<>();

    private static final String[] CAT_KEYS = { "images", "video", "audio", "docs", "archives", "apps", "other" };
    private static final Map<String, Integer> EXT_CAT = new HashMap<>();

    static {
        String[][] sets = {
            { "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "svg", "avif", "raw", "dng" },
            { "mp4", "mkv", "webm", "3gp", "mov", "avi", "m4v", "ts", "flv", "wmv" },
            { "mp3", "m4a", "wav", "ogg", "flac", "aac", "opus", "amr", "mid", "wma" },
            { "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt", "ods", "epub", "log", "json", "xml", "html", "htm" },
            { "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz" },
            { "apk", "xapk", "apks", "obb" }
        };
        for (int i = 0; i < sets.length; i++) {
            for (String e : sets[i]) EXT_CAT.put(e, i);
        }
    }

    private static int catOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return 6;
        Integer c = EXT_CAT.get(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return c == null ? 6 : c;
    }

    private String registerJob(Job j) {
        for (Map.Entry<String, Job> en : jobs.entrySet()) {
            if (en.getValue().done) jobs.remove(en.getKey());
        }
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        jobs.put(id, j);
        return id;
    }

    @PluginMethod
    public void jobStatus(PluginCall call) {
        Job j = jobs.get(call.getString("id", ""));
        if (j == null) {
            call.reject("This task is no longer available.");
            return;
        }
        JSObject r = new JSObject();
        r.put("done", j.done);
        r.put("cancelled", j.cancelled);
        r.put("partial", j.partial);
        r.put("stage", j.stage);
        r.put("files", j.files);
        r.put("bytes", j.bytes);
        r.put("total", j.total);
        if (j.error != null) r.put("error", j.error);
        if (j.done && j.result != null) r.put("result", j.result);
        call.resolve(r);
    }

    @PluginMethod
    public void jobCancel(PluginCall call) {
        Job j = jobs.get(call.getString("id", ""));
        if (j != null) j.cancelled = true;
        call.resolve();
    }

    /* ---- storage scan ---- */

    @PluginMethod
    public void scanStart(final PluginCall call) {
        final String path = call.getString("path");
        if (path == null) {
            call.reject("Missing path.");
            return;
        }
        final Job job = new Job();
        final String id = registerJob(job);
        pool.execute(() -> {
            try {
                runScan(job, new File(path));
            } catch (Throwable t) {
                job.error = "The scan stopped unexpectedly.";
            } finally {
                job.done = true;
            }
        });
        JSObject r = new JSObject();
        r.put("id", id);
        call.resolve(r);
    }

    private void walkScan(File start, Job job, long[] cb, long[] cn, long[] acc, PriorityQueue<Big> heap, long deadline) {
        ArrayDeque<File> stack = new ArrayDeque<>();
        stack.push(start);
        while (!stack.isEmpty()) {
            if (job.cancelled) return;
            if (System.currentTimeMillis() > deadline) {
                job.partial = true;
                return;
            }
            File d = stack.pop();
            if (!d.isDirectory()) {
                countFile(d, job, cb, cn, acc, heap);
                continue;
            }
            File[] fs = d.listFiles();
            if (fs == null) continue;
            for (File f : fs) {
                if (f.isDirectory()) {
                    if (!isSymlink(f)) stack.push(f);
                } else {
                    countFile(f, job, cb, cn, acc, heap);
                }
            }
        }
    }

    private void countFile(File f, Job job, long[] cb, long[] cn, long[] acc, PriorityQueue<Big> heap) {
        long len = f.length();
        int c = catOf(f.getName());
        cb[c] += len;
        cn[c]++;
        acc[0] += len;
        acc[1]++;
        job.files++;
        job.bytes += len;
        if (len > 0) {
            if (heap.size() < 100) {
                heap.add(new Big(f.getAbsolutePath(), len, f.lastModified()));
            } else if (len > heap.peek().size) {
                heap.poll();
                heap.add(new Big(f.getAbsolutePath(), len, f.lastModified()));
            }
        }
    }

    private void runScan(Job job, File root) {
        job.stage = "scanning";
        File[] top = root.listFiles();
        if (top == null) {
            job.error = "Android did not allow reading this folder.";
            return;
        }
        long deadline = System.currentTimeMillis() + 180000L;
        long[] catB = new long[7];
        long[] catN = new long[7];
        PriorityQueue<Big> heap = new PriorityQueue<>(128, new Comparator<Big>() {
            @Override
            public int compare(Big a, Big b) {
                return Long.compare(a.size, b.size);
            }
        });
        List<Kid> kids = new ArrayList<>();
        long total = 0;
        long files = 0;
        for (File c : top) {
            if (job.cancelled) return;
            if (System.currentTimeMillis() > deadline) {
                job.partial = true;
                break;
            }
            long[] cb = new long[7];
            long[] cn = new long[7];
            long[] acc = new long[2];
            if (c.isDirectory()) {
                if (!isSymlink(c)) walkScan(c, job, cb, cn, acc, heap, deadline);
            } else {
                countFile(c, job, cb, cn, acc, heap);
            }
            Kid k = new Kid();
            k.name = c.getName();
            k.path = c.getAbsolutePath();
            k.dir = c.isDirectory();
            k.size = acc[0];
            k.files = acc[1];
            int dom = 6;
            long best = -1;
            for (int i = 0; i < 7; i++) {
                if (cb[i] > best && cb[i] > 0) {
                    best = cb[i];
                    dom = i;
                }
                catB[i] += cb[i];
                catN[i] += cn[i];
            }
            k.cat = dom;
            kids.add(k);
            total += acc[0];
            files += acc[1];
        }
        if (job.cancelled) return;

        Collections.sort(kids, new Comparator<Kid>() {
            @Override
            public int compare(Kid a, Kid b) {
                return Long.compare(b.size, a.size);
            }
        });
        JSArray kidArr = new JSArray();
        long restBytes = 0;
        long restCount = 0;
        for (int i = 0; i < kids.size(); i++) {
            Kid k = kids.get(i);
            if (i >= 80) {
                restBytes += k.size;
                restCount++;
                continue;
            }
            JSObject o = new JSObject();
            o.put("name", k.name);
            o.put("path", k.path);
            o.put("dir", k.dir);
            o.put("size", k.size);
            o.put("files", k.files);
            o.put("cat", CAT_KEYS[k.cat]);
            kidArr.put(o);
        }
        JSArray cats = new JSArray();
        for (int i = 0; i < 7; i++) {
            JSObject c = new JSObject();
            c.put("k", CAT_KEYS[i]);
            c.put("bytes", catB[i]);
            c.put("files", catN[i]);
            cats.put(c);
        }
        List<Big> bigs = new ArrayList<>(heap);
        Collections.sort(bigs, new Comparator<Big>() {
            @Override
            public int compare(Big a, Big b) {
                return Long.compare(b.size, a.size);
            }
        });
        JSArray bigArr = new JSArray();
        for (Big b : bigs) {
            JSObject o = new JSObject();
            o.put("name", new File(b.path).getName());
            o.put("path", b.path);
            o.put("size", b.size);
            o.put("modified", b.mod);
            bigArr.put(o);
        }
        JSObject res = new JSObject();
        res.put("path", root.getAbsolutePath());
        res.put("total", total);
        res.put("files", files);
        res.put("partial", job.partial);
        res.put("categories", cats);
        res.put("children", kidArr);
        res.put("restBytes", restBytes);
        res.put("restCount", restCount);
        res.put("biggest", bigArr);
        res.put("at", System.currentTimeMillis());
        job.stage = "done";
        job.result = res;
    }

    /* ---- duplicate finder ---- */

    @PluginMethod
    public void dupesStart(final PluginCall call) {
        final String path = call.getString("path");
        if (path == null) {
            call.reject("Missing path.");
            return;
        }
        final long minSize = Math.max(1L, call.getData().optLong("minSize", 102400L));
        final boolean hidden = Boolean.TRUE.equals(call.getBoolean("hidden", false));
        final Job job = new Job();
        final String id = registerJob(job);
        pool.execute(() -> {
            try {
                runDupes(job, new File(path), minSize, hidden);
            } catch (Throwable t) {
                job.error = "The search stopped unexpectedly.";
            } finally {
                job.done = true;
            }
        });
        JSObject r = new JSObject();
        r.put("id", id);
        call.resolve(r);
    }

    private static final int QUICK_BYTES = 65536;

    private String hashFile(File f, long limit, String algo, Job job) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance(algo);
            byte[] buf = new byte[65536];
            long left = limit;
            int n;
            while (left > 0 && (n = in.read(buf, 0, (int) Math.min((long) buf.length, left))) > 0) {
                md.update(buf, 0, n);
                left -= n;
                job.bytes += n;
                if (job.cancelled) return null;
            }
            byte[] d = md.digest();
            char[] hex = "0123456789abcdef".toCharArray();
            char[] out = new char[d.length * 2];
            for (int i = 0; i < d.length; i++) {
                int v = d[i] & 0xff;
                out[i * 2] = hex[v >>> 4];
                out[i * 2 + 1] = hex[v & 0x0f];
            }
            return new String(out);
        } catch (Exception e) {
            return null;
        }
    }

    private static void addTo(Map<String, List<String>> m, String key, String value) {
        List<String> l = m.get(key);
        if (l == null) {
            l = new ArrayList<>(2);
            m.put(key, l);
        }
        l.add(value);
    }

    private void runDupes(Job job, File root, long minSize, boolean hidden) {
        job.stage = "listing";
        Map<Long, List<String>> bySize = new HashMap<>();
        ArrayDeque<File> stack = new ArrayDeque<>();
        stack.push(root);
        long deadline = System.currentTimeMillis() + 150000L;
        long listed = 0;
        final long maxFiles = 400000L;
        while (!stack.isEmpty()) {
            if (job.cancelled) return;
            if (System.currentTimeMillis() > deadline || listed > maxFiles) {
                job.partial = true;
                break;
            }
            File d = stack.pop();
            File[] fs = d.listFiles();
            if (fs == null) continue;
            for (File f : fs) {
                String n = f.getName();
                if (f.isDirectory()) {
                    if (n.equals(BIN_NAME)) continue;
                    if (!hidden && n.startsWith(".")) continue;
                    if (!isSymlink(f)) stack.push(f);
                } else {
                    if (!hidden && n.startsWith(".")) continue;
                    listed++;
                    job.files = listed;
                    long len = f.length();
                    if (len > 0 && len >= minSize) {
                        Long key = Long.valueOf(len);
                        List<String> l = bySize.get(key);
                        if (l == null) {
                            l = new ArrayList<>(2);
                            bySize.put(key, l);
                        }
                        l.add(f.getAbsolutePath());
                    }
                }
            }
        }

        List<Map.Entry<Long, List<String>>> cands = new ArrayList<>();
        long candFiles = 0;
        for (Map.Entry<Long, List<String>> en : bySize.entrySet()) {
            if (en.getValue().size() >= 2) {
                cands.add(en);
                candFiles += en.getValue().size();
            }
        }
        Collections.sort(cands, new Comparator<Map.Entry<Long, List<String>>>() {
            @Override
            public int compare(Map.Entry<Long, List<String>> a, Map.Entry<Long, List<String>> b) {
                long wa = a.getKey() * (a.getValue().size() - 1);
                long wb = b.getKey() * (b.getValue().size() - 1);
                return Long.compare(wb, wa);
            }
        });

        job.stage = "comparing";
        job.files = 0;
        job.bytes = 0;
        job.total = candFiles;
        long hashDeadline = System.currentTimeMillis() + 240000L;
        List<Group> groups = new ArrayList<>();
        for (Map.Entry<Long, List<String>> en : cands) {
            if (job.cancelled) return;
            if (System.currentTimeMillis() > hashDeadline) {
                job.partial = true;
                break;
            }
            long size = en.getKey();
            List<String> paths = en.getValue();
            Map<String, List<String>> quick = new HashMap<>();
            for (String p : paths) {
                job.files++;
                File f = new File(p);
                if (f.length() != size) continue;
                String h = hashFile(f, Math.min(size, (long) QUICK_BYTES), "SHA-1", job);
                if (job.cancelled) return;
                if (h != null) addTo(quick, h, p);
            }
            for (List<String> ql : quick.values()) {
                if (ql.size() < 2) continue;
                if (size <= QUICK_BYTES) {
                    Group g = new Group();
                    g.size = size;
                    g.files = ql;
                    groups.add(g);
                    continue;
                }
                Map<String, List<String>> full = new HashMap<>();
                for (String p : ql) {
                    String h = hashFile(new File(p), size, "SHA-256", job);
                    if (job.cancelled) return;
                    if (h != null) addTo(full, h, p);
                }
                for (List<String> fl : full.values()) {
                    if (fl.size() >= 2) {
                        Group g = new Group();
                        g.size = size;
                        g.files = fl;
                        groups.add(g);
                    }
                }
            }
        }
        if (job.cancelled) return;

        Collections.sort(groups, new Comparator<Group>() {
            @Override
            public int compare(Group a, Group b) {
                return Long.compare(b.size * (b.files.size() - 1), a.size * (a.files.size() - 1));
            }
        });
        long wasted = 0;
        for (Group g : groups) wasted += g.size * (g.files.size() - 1);
        JSArray arr = new JSArray();
        for (int i = 0; i < groups.size() && i < 300; i++) {
            Group g = groups.get(i);
            JSArray fa = new JSArray();
            for (int j = 0; j < g.files.size() && j < 30; j++) {
                File f = new File(g.files.get(j));
                JSObject o = new JSObject();
                o.put("path", f.getAbsolutePath());
                o.put("name", f.getName());
                o.put("modified", f.lastModified());
                fa.put(o);
            }
            JSObject go = new JSObject();
            go.put("size", g.size);
            go.put("count", g.files.size());
            go.put("files", fa);
            arr.put(go);
        }
        JSObject res = new JSObject();
        res.put("path", root.getAbsolutePath());
        res.put("groups", arr);
        res.put("groupCount", groups.size());
        res.put("wasted", wasted);
        res.put("scanned", job.files);
        res.put("partial", job.partial);
        res.put("at", System.currentTimeMillis());
        job.stage = "done";
        job.result = res;
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
