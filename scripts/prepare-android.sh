#!/usr/bin/env bash
# Prepares the Android Capacitor project from a dedicated SPA build.
#
# - Builds a static SPA via vite.config.capacitor.ts (output: dist/android/).
# - Falls back to hoisting index.html if it ends up in a nested folder
#   (different Vite versions handle rollup `input` paths slightly differently).
# - Validates the final layout before invoking Capacitor.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

LOGO_URL="${TEMPOKEY_LOGO_URL:-https://tempokey.lovable.app/__l5e/assets-v1/00136921-a419-4bb4-8cf6-ca6ffceafbba/tempokey-logo.png}"
LOCAL_LOGO="src/assets/tempokey-logo.png"
WEB_DIR="dist/android"
RES_DIR="resources"

echo "▶ Installing Capacitor toolchain (idempotent)…"
npm install --no-audit --no-fund --save-dev \
  @capacitor/cli@^6 \
  @capacitor/assets@^3 >/dev/null
npm install --no-audit --no-fund --save \
  @capacitor/core@^6 \
  @capacitor/android@^6 \
  @capacitor/splash-screen@^6 \
  @capacitor/status-bar@^6 \
  @capacitor/app@^6 \
  @capacitor/keyboard@^6 \
  @capacitor/filesystem@^6 >/dev/null

echo "▶ Building static SPA for WebView (vite.config.capacitor.ts)…"
rm -rf "$WEB_DIR"
npx vite build --config vite.config.capacitor.ts

# Hoist index.html if Vite emitted it inside a nested subfolder.
if [ ! -f "$WEB_DIR/index.html" ]; then
  NESTED=$(find "$WEB_DIR" -maxdepth 3 -type f -name "index.html" | head -n1 || true)
  if [ -n "$NESTED" ]; then
    NEST_DIR=$(dirname "$NESTED")
    echo "▶ Hoisting $NESTED → $WEB_DIR/index.html"
    cp "$NESTED" "$WEB_DIR/index.html"
    # Move sibling assets too if they live next to the nested index.html
    if [ "$NEST_DIR" != "$WEB_DIR" ] && [ -d "$NEST_DIR" ]; then
      shopt -s dotglob nullglob
      for f in "$NEST_DIR"/*; do
        base=$(basename "$f")
        [ "$base" = "index.html" ] && continue
        [ -e "$WEB_DIR/$base" ] && continue
        mv "$f" "$WEB_DIR/"
      done
      shopt -u dotglob nullglob
      rmdir "$NEST_DIR" 2>/dev/null || true
    fi
  fi
fi

if [ ! -f "$WEB_DIR/index.html" ]; then
  echo "❌ Android SPA build did not produce $WEB_DIR/index.html" >&2
  echo "Tree:" >&2
  find "$WEB_DIR" -maxdepth 3 -type f >&2 || true
  exit 1
fi
echo "✓ $WEB_DIR/index.html present"

# Sanity check: the built index.html must reference real bundled assets.
if ! grep -qE 'src="\.?/?assets/' "$WEB_DIR/index.html"; then
  echo "❌ index.html does not reference any bundled asset — black screen guaranteed." >&2
  cat "$WEB_DIR/index.html" >&2
  exit 1
fi
echo "✓ index.html links bundled assets"

echo "▶ Preparing icon & splash sources…"
mkdir -p "$RES_DIR"
# Prefer the bundled official logo committed in the repo. Fall back to CDN.
if [ -f "$LOCAL_LOGO" ]; then
  cp -f "$LOCAL_LOGO" "$RES_DIR/icon.png"
elif [ ! -f "$RES_DIR/icon.png" ]; then
  curl -L --silent --fail "$LOGO_URL" -o "$RES_DIR/icon.png"
fi
if [ ! -f "$RES_DIR/splash.png" ]; then
  cp -f "$RES_DIR/icon.png" "$RES_DIR/splash.png"
fi
cp -f "$RES_DIR/icon.png" "android-resources/logo.png" 2>/dev/null || true

echo "▶ Adding Android platform (if missing)…"
if [ ! -d "android" ]; then
  npx cap add android
fi

echo "▶ Generating launcher icons, adaptive icon & splash…"
npx @capacitor/assets generate --android \
  --iconBackgroundColor "#FFFFFF" \
  --iconBackgroundColorDark "#FFFFFF" \
  --splashBackgroundColor "#FFFFFF" \
  --splashBackgroundColorDark "#FFFFFF" || {
    echo "⚠ @capacitor/assets failed; continuing with platform defaults." >&2
  }

echo "▶ Syncing Capacitor…"
npx cap sync android

# ──────────────────────────────────────────────────────────────────────────
# Install our custom Android folder-picker plugin into the gradle project.
# Uses ACTION_OPEN_DOCUMENT_TREE + takePersistableUriPermission so users
# pick a real Android folder through the system picker (no webkitdirectory).
# ──────────────────────────────────────────────────────────────────────────
PLUGIN_PKG_DIR="android/app/src/main/java/app/lovable/tempokey/folderpicker"
if [ -d "android/app" ]; then
  echo "▶ Installing native FolderPicker plugin…"
  mkdir -p "$PLUGIN_PKG_DIR"
  cat > "$PLUGIN_PKG_DIR/FolderPickerPlugin.java" <<'JAVA'
package app.lovable.tempokey.folderpicker;

import android.app.Activity;
import android.Manifest;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "FolderPicker",
    permissions = {
        @Permission(alias = "audio33", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage32", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class FolderPickerPlugin extends Plugin {

    private static final String[] AUDIO_EXT = {
        ".mp3", ".wav", ".flac", ".aac", ".m4a", ".mp4", ".ogg", ".oga", ".aiff", ".aif", ".wma", ".opus", ".webm"
    };
    private static final String PREFS = "tempokey_audio_permissions";
    private static final String REQUESTED = "requested";

    private String permissionAlias() {
        if (Build.VERSION.SDK_INT < 23) return "unsupported";
        return Build.VERSION.SDK_INT >= 33 ? "audio33" : "storage32";
    }

    private String androidPermission() {
        return Build.VERSION.SDK_INT >= 33
            ? Manifest.permission.READ_MEDIA_AUDIO
            : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    private String normalizedPermissionState() {
        String alias = permissionAlias();
        if ("unsupported".equals(alias)) return "granted";
        PermissionState state = getPermissionState(alias);
        if (state == PermissionState.GRANTED) return "granted";
        boolean requested = getContext()
            .getSharedPreferences(PREFS, 0)
            .getBoolean(REQUESTED, false);
        boolean rationale = getActivity().shouldShowRequestPermissionRationale(androidPermission());
        return requested && !rationale ? "blocked" : "denied";
    }

    @PluginMethod
    public void checkAudioPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("state", normalizedPermissionState());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAudioPermission(PluginCall call) {
        String alias = permissionAlias();
        if ("unsupported".equals(alias)) {
            JSObject ret = new JSObject();
            ret.put("state", "granted");
            call.resolve(ret);
            return;
        }
        if (getPermissionState(alias) == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("state", "granted");
            call.resolve(ret);
            return;
        }
        getContext().getSharedPreferences(PREFS, 0).edit().putBoolean(REQUESTED, true).apply();
        requestPermissionForAlias(alias, call, "audioPermissionCallback");
    }

    @PermissionCallback
    private void audioPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("state", normalizedPermissionState());
        call.resolve(ret);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("OPEN_SETTINGS_FAIL", e);
        }
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        String alias = permissionAlias();
        if (!"unsupported".equals(alias) && getPermissionState(alias) != PermissionState.GRANTED) {
            getContext().getSharedPreferences(PREFS, 0).edit().putBoolean(REQUESTED, true).apply();
            requestPermissionForAlias(alias, call, "pickFolderPermissionCallback");
            return;
        }
        openDocumentTree(call);
    }

    @PermissionCallback
    private void pickFolderPermissionCallback(PluginCall call) {
        String alias = permissionAlias();
        if ("unsupported".equals(alias) || getPermissionState(alias) == PermissionState.GRANTED) {
            openDocumentTree(call);
            return;
        }
        call.reject("AUDIO_PERMISSION_DENIED");
    }

    private void openDocumentTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "handlePickResult");
    }

    @ActivityCallback
    private void handlePickResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("CANCELLED");
            return;
        }
        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("NO_URI");
            return;
        }
        int grantedFlags = result.getData().getFlags();
        int takeFlags = grantedFlags & (
            Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        );
        if ((takeFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) {
            takeFlags |= Intent.FLAG_GRANT_READ_URI_PERMISSION;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(treeUri, takeFlags);
        } catch (Exception first) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception second) {
                call.reject("PERSIST_PERMISSION_FAIL", second);
                return;
            }
        }

        String name = "";
        try {
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(
                treeUri, DocumentsContract.getTreeDocumentId(treeUri)
            );
            Cursor c = getContext().getContentResolver().query(
                docUri,
                new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
                null, null, null
            );
            if (c != null) {
                try { if (c.moveToFirst()) name = c.getString(0); }
                finally { c.close(); }
            }
        } catch (Exception ignored) {}

        JSObject ret = new JSObject();
        ret.put("treeUri", treeUri.toString());
        ret.put("name", name == null ? "" : name);
        call.resolve(ret);
    }

    @PluginMethod
    public void listAudioFiles(PluginCall call) {
        String treeUriStr = call.getString("treeUri");
        if (treeUriStr == null) { call.reject("MISSING_TREE_URI"); return; }
        Uri treeUri = Uri.parse(treeUriStr);
        ContentResolver cr = getContext().getContentResolver();
        String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);

        String rootName = "";
        try {
            Uri rootUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId);
            Cursor c = cr.query(
                rootUri,
                new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
                null, null, null
            );
            if (c != null) {
                try { if (c.moveToFirst()) rootName = c.getString(0); }
                finally { c.close(); }
            }
        } catch (Exception ignored) {}

        JSArray files = new JSArray();
        walk(cr, treeUri, rootDocId, rootName == null ? "" : rootName, files);

        JSObject ret = new JSObject();
        ret.put("rootName", rootName == null ? "" : rootName);
        ret.put("files", files);
        call.resolve(ret);
    }

    private void walk(
        ContentResolver cr, Uri treeUri, String parentDocId, String relPrefix, JSArray out
    ) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
        String[] proj = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        };
        Cursor c = null;
        try {
            c = cr.query(children, proj, null, null, null);
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                long size = c.isNull(3) ? 0L : c.getLong(3);
                if (name == null) continue;
                String childRel = relPrefix.isEmpty() ? name : (relPrefix + "/" + name);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(cr, treeUri, id, childRel, out);
                } else {
                    boolean isAudio = (mime != null && mime.startsWith("audio/"));
                    if (!isAudio) {
                        String lower = name.toLowerCase();
                        for (String ext : AUDIO_EXT) {
                            if (lower.endsWith(ext)) { isAudio = true; break; }
                        }
                    }
                    if (isAudio) {
                        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id);
                        JSObject o = new JSObject();
                        o.put("uri", docUri.toString());
                        o.put("name", name);
                        o.put("relativePath", childRel);
                        o.put("size", size);
                        o.put("mime", mime == null ? "" : mime);
                        out.put(o);
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) try { c.close(); } catch (Exception ignored) {}
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String uriStr = call.getString("uri");
        long offset = call.getLong("offset", 0L);
        long length = call.getLong("length", -1L);
        if (uriStr == null) { call.reject("MISSING_URI"); return; }
        InputStream is = null;
        try {
            Uri uri = Uri.parse(uriStr);
            is = openUriInputStream(uri);
            long skipped = 0;
            while (skipped < offset) {
                long s = is.skip(offset - skipped);
                if (s <= 0) break;
                skipped += s;
            }
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            long remaining = length < 0 ? Long.MAX_VALUE : length;
            int n;
            while (remaining > 0) {
                int toRead = (int) Math.min((long) chunk.length, remaining);
                n = is.read(chunk, 0, toRead);
                if (n <= 0) break;
                buf.write(chunk, 0, n);
                remaining -= n;
            }
            byte[] data = buf.toByteArray();
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("READ_FAIL", e);
        } finally {
            if (is != null) try { is.close(); } catch (Exception ignored) {}
        }
    }

    @PluginMethod
    public void persistAudioFiles(PluginCall call) {
        String libraryId = call.getString("libraryId", "library");
        JSArray input = call.getArray("files");
        if (input == null) { call.reject("MISSING_FILES"); return; }

        File dir = new File(getContext().getFilesDir(), "tempokey-audio/" + sanitizeName(libraryId));
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("STORE_DIR_FAIL");
            return;
        }

        JSArray entries = new JSArray();
        try {
            for (int i = 0; i < input.length(); i++) {
                JSONObject item = input.getJSONObject(i);
                String trackId = item.optString("trackId", "");
                JSONObject meta = item.optJSONObject("meta");
                if (trackId.isEmpty() || meta == null) continue;

                String uriStr = meta.optString("uri", "");
                String name = meta.optString("name", "audio");
                String relativePath = meta.optString("relativePath", name);
                String mime = meta.optString("mime", "");
                long size = meta.optLong("size", 0L);
                if (uriStr.isEmpty()) continue;

                String ext = extensionFromName(name);
                if (ext.isEmpty()) ext = extensionFromMime(mime);
                if (mime == null || mime.isEmpty() || "application/octet-stream".equals(mime)) {
                    mime = mimeFromExtension(ext);
                }
                String safeName = sanitizeName(name);
                if (safeName.isEmpty()) safeName = "audio";
                String safe = sha1(trackId + uriStr) + "-" + safeName;
                if (!ext.isEmpty() && !safe.toLowerCase().endsWith("." + ext)) safe = safe + "." + ext;
                File out = new File(dir, safe);

                copyUriToFile(Uri.parse(uriStr), out, size);

                JSObject nextMeta = new JSObject();
                nextMeta.put("uri", uriStr);
                nextMeta.put("storedUri", Uri.fromFile(out).toString());
                nextMeta.put("name", name);
                nextMeta.put("relativePath", relativePath);
                nextMeta.put("size", out.length() > 0L ? out.length() : size);
                nextMeta.put("mime", mime == null ? "" : mime);

                JSObject entry = new JSObject();
                entry.put("trackId", trackId);
                entry.put("meta", nextMeta);
                entries.put(entry);
            }

            JSObject ret = new JSObject();
            ret.put("entries", entries);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("PERSIST_AUDIO_FAIL", e);
        }
    }

    private void copyUriToFile(Uri src, File out, long expectedSize) throws Exception {
        if (out.exists() && out.length() > 0L && (expectedSize <= 0L || out.length() == expectedSize)) return;
        InputStream is = null;
        FileOutputStream os = null;
        try {
            is = openUriInputStream(src);
            os = new FileOutputStream(out, false);
            byte[] chunk = new byte[256 * 1024];
            int n;
            while ((n = is.read(chunk)) > 0) os.write(chunk, 0, n);
            os.flush();
        } finally {
            if (os != null) try { os.close(); } catch (Exception ignored) {}
            if (is != null) try { is.close(); } catch (Exception ignored) {}
        }
    }

    private InputStream openUriInputStream(Uri uri) throws Exception {
        if (uri == null) throw new Exception("MISSING_URI");
        if ("file".equals(uri.getScheme())) {
            String path = uri.getPath();
            if (path == null || path.isEmpty()) throw new Exception("OPEN_FAIL");
            return new FileInputStream(new File(path));
        }
        InputStream is = getContext().getContentResolver().openInputStream(uri);
        if (is == null) throw new Exception("OPEN_FAIL");
        return is;
    }

    @PluginMethod
    public void getPlayableUri(PluginCall call) {
        String uriStr = call.getString("uri");
        String name = call.getString("name", "audio");
        String mime = call.getString("mime", "");
        long expectedSize = call.getLong("size", -1L);
        if (uriStr == null) { call.reject("MISSING_URI"); return; }
        InputStream is = null;
        FileOutputStream os = null;
        try {
            Uri uri = Uri.parse(uriStr);
            String ext = extensionFromName(name);
            if (ext.isEmpty()) ext = extensionFromMime(mime);
            if (mime == null || mime.isEmpty() || "application/octet-stream".equals(mime)) {
                mime = mimeFromExtension(ext);
            }
            if ("file".equals(uri.getScheme())) {
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                ret.put("mime", mime == null ? "" : mime);
                call.resolve(ret);
                return;
            }
            is = openUriInputStream(uri);
            String hash = sha1(uriStr);
            String safe = sanitizeName(name);
            if (safe.isEmpty()) safe = "audio";
            if (!ext.isEmpty() && !safe.toLowerCase().endsWith("." + ext)) safe = safe + "." + ext;
            File dir = new File(getContext().getCacheDir(), "tempokey-audio");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, hash + "-" + safe);
            if (!out.exists() || out.length() == 0L || (expectedSize > 0L && out.length() != expectedSize)) {
                os = new FileOutputStream(out, false);
                byte[] chunk = new byte[128 * 1024];
                int n;
                while ((n = is.read(chunk)) > 0) os.write(chunk, 0, n);
                os.flush();
            }

            JSObject ret = new JSObject();
            ret.put("uri", Uri.fromFile(out).toString());
            ret.put("mime", mime == null ? "" : mime);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("PLAYABLE_COPY_FAIL", e);
        } finally {
            if (os != null) try { os.close(); } catch (Exception ignored) {}
            if (is != null) try { is.close(); } catch (Exception ignored) {}
        }
    }

    private String extensionFromName(String name) {
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        if (i < 0 || i >= name.length() - 1) return "";
        return name.substring(i + 1).toLowerCase();
    }

    private String extensionFromMime(String mime) {
        if (mime == null) return "";
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        return ext == null ? "" : ext.toLowerCase();
    }

    private String mimeFromExtension(String ext) {
        if (ext == null) return "";
        switch (ext.toLowerCase()) {
            case "mp3": return "audio/mpeg";
            case "m4a":
            case "mp4":
            case "aac": return "audio/mp4";
            case "wav": return "audio/wav";
            case "flac": return "audio/flac";
            case "ogg":
            case "oga": return "audio/ogg";
            case "opus": return "audio/ogg";
            case "webm": return "audio/webm";
            case "aiff":
            case "aif": return "audio/aiff";
            case "wma": return "audio/x-ms-wma";
            default:
                String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
                return mime == null ? "" : mime;
        }
    }

    private String sanitizeName(String name) {
        if (name == null) return "";
        return name.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private String sha1(String value) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        byte[] dig = md.digest(value.getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder();
        for (byte b : dig) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    @PluginMethod
    public void hasPersistedAccess(PluginCall call) {
        String treeUriStr = call.getString("treeUri");
        boolean granted = false;
        if (treeUriStr != null) {
            Uri target = Uri.parse(treeUriStr);
            for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (p.getUri().equals(target) && p.isReadPermission()) {
                    granted = true;
                    break;
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void renameDocument(PluginCall call) {
        String uriStr = call.getString("uri");
        String newName = call.getString("newName");
        if (uriStr == null || newName == null) {
            call.reject("MISSING_ARGS");
            return;
        }
        try {
            Uri oldUri = Uri.parse(uriStr);
            if ("file".equals(oldUri.getScheme())) {
                String path = oldUri.getPath();
                if (path == null || path.isEmpty()) {
                    call.reject("RENAME_FAILED");
                    return;
                }
                File oldFile = new File(path);
                File parent = oldFile.getParentFile();
                if (parent == null) {
                    call.reject("RENAME_FAILED");
                    return;
                }
                File newFile = new File(parent, sanitizeName(newName));
                if (!oldFile.renameTo(newFile)) {
                    call.reject("RENAME_FAILED");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("uri", Uri.fromFile(newFile).toString());
                ret.put("name", newName);
                call.resolve(ret);
                return;
            }
            Uri newUri = DocumentsContract.renameDocument(
                getContext().getContentResolver(), oldUri, newName
            );
            if (newUri == null) {
                call.reject("RENAME_FAILED");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("uri", newUri.toString());
            ret.put("name", newName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("RENAME_ERROR", e);
        }
    }

    @PluginMethod
    public void deleteDocument(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("MISSING_ARGS"); return; }
        try {
            Uri target = Uri.parse(uriStr);
            boolean ok = false;
            if ("file".equals(target.getScheme())) {
                String path = target.getPath();
                if (path != null) {
                    File f = new File(path);
                    ok = !f.exists() || f.delete();
                }
            } else {
                ok = DocumentsContract.deleteDocument(
                    getContext().getContentResolver(), target
                );
            }
            if (!ok) { call.reject("DELETE_FAILED"); return; }
            JSObject ret = new JSObject();
            ret.put("deleted", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("DELETE_ERROR", e);
        }
    }
}
JAVA

  echo "▶ Registering FolderPicker plugin in MainActivity…"
  node <<'NODE'
const fs = require("fs");
const path = require("path");

function find(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = find(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return null;
}

const mainActivity = find("android/app/src/main/java", "MainActivity.java");
if (!mainActivity) {
  console.log("  ⚠ MainActivity.java not found, skipping registration");
  process.exit(0);
}
let src = fs.readFileSync(mainActivity, "utf8");
const importLine =
  'import app.lovable.tempokey.folderpicker.FolderPickerPlugin;';
const registerLine =
  '    registerPlugin(FolderPickerPlugin.class);';

let changed = false;
if (!src.includes(importLine)) {
  src = src.replace(
    /(import com\.getcapacitor\.BridgeActivity;)/,
    `$1\n${importLine}`,
  );
  changed = true;
}

if (!src.includes("registerPlugin(FolderPickerPlugin.class)")) {
  // In Capacitor, custom plugins must be registered BEFORE super.onCreate().
  if (/super\.onCreate\([^)]*\);/.test(src)) {
    src = src.replace(
      /(\n[ \t]*)(super\.onCreate\([^)]*\);)/,
      `$1${registerLine.trim()}\n$1$2`,
    );
  } else {
    // Inject a minimal onCreate override before the closing class brace.
    src = src.replace(
      /\}\s*$/,
      `    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n${registerLine}\n        super.onCreate(savedInstanceState);\n    }\n}\n`,
    );
  }
  changed = true;
}

if (changed) {
  fs.writeFileSync(mainActivity, src);
  console.log("  ✓ MainActivity.java updated:", mainActivity);
} else {
  console.log("  ✓ MainActivity.java already registers FolderPicker");
}
NODE
fi

# ──────────────────────────────────────────────────────────────────────────
# Install the AnalysisNotification plugin + foreground service.
# Keeps a persistent native notification visible (with live progress) and
# acquires a partial WakeLock so the WebView's analysis JS keeps running
# while the app is in background / screen locked.
# ──────────────────────────────────────────────────────────────────────────
ANALYSIS_PKG_DIR="android/app/src/main/java/app/lovable/tempokey/analysis"
if [ -d "android/app" ]; then
  echo "▶ Installing native AnalysisNotification plugin…"
  mkdir -p "$ANALYSIS_PKG_DIR"
  cat > "$ANALYSIS_PKG_DIR/AnalysisForegroundService.java" <<'JAVA'
package app.lovable.tempokey.analysis;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

public class AnalysisForegroundService extends Service {
    public static final String CHANNEL_ID = "tempokey_analysis";
    public static final int NOTIF_ID = 4242;
    public static final String ACTION_START = "tempokey.analysis.START";
    public static final String ACTION_UPDATE = "tempokey.analysis.UPDATE";
    public static final String ACTION_FINISH = "tempokey.analysis.FINISH";
    public static final String ACTION_CANCEL = "tempokey.analysis.CANCEL";

    private PowerManager.WakeLock wakeLock;
    private int total = 0;
    private int done = 0;
    private String currentTitle = "";
    private boolean running = false;

    public static int currentDone = 0;
    public static int currentTotal = 0;
    public static boolean currentRunning = false;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_STICKY;
        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            total = intent.getIntExtra("total", 0);
            done = 0;
            currentTitle = intent.getStringExtra("title");
            if (currentTitle == null) currentTitle = "Analyse en cours";
            running = true;
            currentRunning = true;
            currentTotal = total;
            currentDone = 0;
            startForegroundCompat(buildProgressNotification());
            acquireWake();
        } else if (ACTION_UPDATE.equals(action)) {
            done = intent.getIntExtra("done", done);
            total = intent.getIntExtra("total", total);
            String t = intent.getStringExtra("currentTitle");
            if (t != null) currentTitle = t;
            currentDone = done;
            currentTotal = total;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, buildProgressNotification());
        } else if (ACTION_FINISH.equals(action)) {
            boolean ok = intent.getBooleanExtra("ok", true);
            String msg = intent.getStringExtra("message");
            if (msg == null) msg = ok ? "Bibliothèque prête" : "Analyse interrompue";
            running = false;
            currentRunning = false;
            releaseWake();
            try { stopForeground(STOP_FOREGROUND_DETACH); } catch (Throwable ignored) {
                stopForeground(false);
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, buildFinalNotification(ok, msg));
            stopSelf();
        } else if (ACTION_CANCEL.equals(action)) {
            running = false;
            currentRunning = false;
            releaseWake();
            try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable ignored) {
                stopForeground(true);
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ID);
            stopSelf();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseWake();
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Analyse audio", NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("Analyse de la bibliothèque en arrière-plan");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent contentIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent();
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, launch, flags);
    }

    private int smallIcon() {
        int id = getResources().getIdentifier("ic_stat_icon", "drawable", getPackageName());
        if (id != 0) return id;
        id = getResources().getIdentifier("ic_launcher_foreground", "mipmap", getPackageName());
        if (id != 0) return id;
        return android.R.drawable.stat_sys_download;
    }

    private Notification buildProgressNotification() {
        int pct = total > 0 ? (int) Math.floor((done * 100.0) / total) : 0;
        String text = "Analyse en cours · " + done + " / " + total + " (" + pct + " %)";
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(smallIcon())
            .setContentTitle("TempoKey")
            .setContentText(text)
            .setSubText(currentTitle)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setProgress(total > 0 ? total : 100, done, total <= 0)
            .setContentIntent(contentIntent());
        return b.build();
    }

    private Notification buildFinalNotification(boolean ok, String msg) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(smallIcon())
            .setContentTitle(ok ? "TempoKey · Analyse terminée" : "TempoKey · Erreur d'analyse")
            .setContentText(msg)
            .setOngoing(false)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(contentIntent());
        return b.build();
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                return;
            } catch (Throwable ignored) {}
        }
        startForeground(NOTIF_ID, n);
    }

    private void acquireWake() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TempoKey:Analysis");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(60 * 60 * 1000L);
        } catch (Throwable ignored) {}
    }

    private void releaseWake() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); }
        catch (Throwable ignored) {}
        wakeLock = null;
    }
}
JAVA

  cat > "$ANALYSIS_PKG_DIR/AnalysisNotificationPlugin.java" <<'JAVA'
package app.lovable.tempokey.analysis;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "AnalysisNotification",
    permissions = {
        @Permission(alias = "notif", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class AnalysisNotificationPlugin extends Plugin {

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("notif") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notif", call, "notifPermCallback");
    }

    @PermissionCallback
    private void notifPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("notif") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        int total = call.getInt("total", 0);
        String title = call.getString("title", "Analyse en cours");
        Intent i = new Intent(getContext(), AnalysisForegroundService.class);
        i.setAction(AnalysisForegroundService.ACTION_START);
        i.putExtra("total", total);
        i.putExtra("title", title);
        startService(i);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void update(PluginCall call) {
        Intent i = new Intent(getContext(), AnalysisForegroundService.class);
        i.setAction(AnalysisForegroundService.ACTION_UPDATE);
        i.putExtra("done", call.getInt("done", 0));
        i.putExtra("total", call.getInt("total", 0));
        i.putExtra("currentTitle", call.getString("currentTitle", ""));
        startService(i);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void finish(PluginCall call) {
        Intent i = new Intent(getContext(), AnalysisForegroundService.class);
        i.setAction(AnalysisForegroundService.ACTION_FINISH);
        i.putExtra("ok", call.getBoolean("ok", true));
        i.putExtra("message", call.getString("message", ""));
        startService(i);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Intent i = new Intent(getContext(), AnalysisForegroundService.class);
        i.setAction(AnalysisForegroundService.ACTION_CANCEL);
        startService(i);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void getCurrentState(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", AnalysisForegroundService.currentRunning);
        ret.put("done", AnalysisForegroundService.currentDone);
        ret.put("total", AnalysisForegroundService.currentTotal);
        call.resolve(ret);
    }

    private void startService(Intent i) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(i);
        } else {
            getContext().startService(i);
        }
    }
}
JAVA

  echo "▶ Registering AnalysisNotification plugin in MainActivity…"
  node <<'NODE'
const fs = require("fs");
const path = require("path");

function find(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = find(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return null;
}

const mainActivity = find("android/app/src/main/java", "MainActivity.java");
if (!mainActivity) process.exit(0);
let src = fs.readFileSync(mainActivity, "utf8");
const importLine = 'import app.lovable.tempokey.analysis.AnalysisNotificationPlugin;';
const registerLine = '        registerPlugin(AnalysisNotificationPlugin.class);';
let changed = false;
if (!src.includes(importLine)) {
  src = src.replace(
    /(import com\.getcapacitor\.BridgeActivity;)/,
    `$1\n${importLine}`,
  );
  changed = true;
}
if (!src.includes("registerPlugin(AnalysisNotificationPlugin.class)")) {
  src = src.replace(
    /(\n[ \t]*)(super\.onCreate\([^)]*\);)/,
    `$1${registerLine.trim()}\n$1$2`,
  );
  changed = true;
}
if (changed) {
  fs.writeFileSync(mainActivity, src);
  console.log("  ✓ MainActivity.java registers AnalysisNotification");
}
NODE
fi

# ──────────────────────────────────────────────────────────────────────────
# Harden the generated MainActivity WebView for Android keyboard/back flows.
# Keeping text zoom fixed prevents Android accessibility/font autosizing from
# relaying out focused inputs mid-keystroke, and disabling overscroll removes
# the WebView edge gesture that can conflict with Capacitor back handling.
# ──────────────────────────────────────────────────────────────────────────
if [ -d "android/app" ]; then
  echo "▶ Applying MainActivity WebView stability settings…"
  node <<'NODE'
const fs = require("fs");
const path = require("path");

function find(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = find(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return null;
}

const mainActivity = find("android/app/src/main/java", "MainActivity.java");
if (!mainActivity) process.exit(0);
let src = fs.readFileSync(mainActivity, "utf8");
if (!src.includes("setTextZoom(100)")) {
  const stabilityBlock = `
        try {
            if (bridge != null && bridge.getWebView() != null) {
                android.webkit.WebSettings settings = bridge.getWebView().getSettings();
                settings.setTextZoom(100);
                settings.setMediaPlaybackRequiresUserGesture(false);
                settings.setDomStorageEnabled(true);
                bridge.getWebView().setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
            }
        } catch (Exception ignored) {}`;

  if (/super\.onCreate\([^)]*\);/.test(src)) {
    src = src.replace(/(super\.onCreate\([^)]*\);)/, `$1${stabilityBlock}`);
  } else {
    src = src.replace(
      /\}\s*$/,
      `    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);${stabilityBlock}\n    }\n}\n`,
    );
  }
  fs.writeFileSync(mainActivity, src);
  console.log("  ✓ MainActivity.java WebView settings hardened");
} else {
  console.log("  ✓ MainActivity.java WebView settings already present");
}
NODE
fi

# ──────────────────────────────────────────────────────────────────────────
# Inject TempoKey's audio-file permissions into AndroidManifest.xml.
# Capacitor's default manifest only declares INTERNET, which makes Android
# App Info show "No permissions requested". We add the minimal set required
# for analysing the user's local music library:
#   • READ_MEDIA_AUDIO       – Android 13+ (API 33+) scoped media access
#   • READ_EXTERNAL_STORAGE  – Android 10–12 fallback (maxSdkVersion=32)
# No camera, location, contacts or other permissions are declared.
# ──────────────────────────────────────────────────────────────────────────
MANIFEST="android/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  echo "▶ Patching AndroidManifest.xml with audio permissions and WebView input stability…"
  node <<'NODE'
const fs = require("fs");
const path = "android/app/src/main/AndroidManifest.xml";
let xml = fs.readFileSync(path, "utf8");

const perms = [
  '<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
];

let changed = false;
for (const line of perms) {
  const attr = line.match(/android:name="([^"]+)"/)[1];
  if (!xml.includes(`android:name="${attr}"`)) {
    xml = xml.replace(/<\/manifest>/, `    ${line}\n</manifest>`);
    changed = true;
  }
}

// Keep the Capacitor WebView on the normal Android keyboard resize path.
// Without this, fullscreen / edge-to-edge windows can relayout unpredictably
// when an input opens the IME, which looks like a hard freeze in the APK.
xml = xml.replace(/<activity\b([^>]*)>/, (match, attrs) => {
  let next = attrs;
  const ensureAttr = (name, value) => {
    const re = new RegExp(`${name}="[^"]*"`);
    if (re.test(next)) next = next.replace(re, `${name}="${value}"`);
    else next += `\n            ${name}="${value}"`;
  };
  ensureAttr("android:windowSoftInputMode", "adjustResize");
  ensureAttr("android:hardwareAccelerated", "true");
  return `<activity${next}>`;
});

// Declare the AnalysisForegroundService inside <application>.
const serviceDecl =
  '<service\n' +
  '            android:name="app.lovable.tempokey.analysis.AnalysisForegroundService"\n' +
  '            android:exported="false"\n' +
  '            android:foregroundServiceType="dataSync" />';
if (!xml.includes('app.lovable.tempokey.analysis.AnalysisForegroundService')) {
  xml = xml.replace(/<\/application>/, `        ${serviceDecl}\n    </application>`);
}

if (changed || xml !== fs.readFileSync(path, "utf8")) {
  fs.writeFileSync(path, xml);
  console.log("  ✓ AndroidManifest.xml updated");
} else {
  console.log("  ✓ AndroidManifest.xml already up to date");
}
NODE
fi

echo "✅ Android project prepared at ./android (webDir=$WEB_DIR)"
