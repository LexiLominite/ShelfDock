package app.lexbridge;
import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.provider.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;


final class FileTransfers {
    static final Object LOCK = new Object();
    private final Context context;
    private volatile boolean cancelled;
    private volatile HttpURLConnection active;
    private volatile Uri pending;
    private final String sessionToken;
    private long lastSessionCheck;
    FileTransfers(Context context) { this.context = context; JSONObject credential = Vault.load(context); sessionToken = credential == null ? "" : credential.optString("token"); }
    static String safeError(Exception e) {
        if (e instanceof Api.ApiError || e instanceof IllegalArgumentException) return "Transfer failed: " + e.getMessage();
        return "Transfer failed. Check the connection and available storage, then retry.";
    }
    private Notification progress(String name, long bytes, long total) {
        boolean auto = context instanceof ConnectionService;
        PendingIntent cancel = PendingIntent.getService(context, auto ? 6 : 5, new Intent(context, auto ? ConnectionService.class : TransferService.class).setAction(auto ? "stop" : "cancel"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String detail = total > 0 ? (bytes * 100 / total) + "% · " + format(bytes) + " / " + format(total) : format(bytes);
        return Notices.builder(context, "transfers", name, detail).setOngoing(true).setOnlyAlertOnce(true).setSound(null).setProgress(100, total > 0 ? (int) Math.min(100, bytes * 100 / total) : 0, total <= 0).addAction(new Notification.Action.Builder(null, auto ? "Disconnect" : "Cancel", cancel).build()).build();
    }
    static String format(long bytes) { if (bytes < 1024) return bytes + " B"; if (bytes < 1048576) return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0); return String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0); }
    private void update(String name, long bytes, long total) { context.getSystemService(NotificationManager.class).notify(context instanceof ConnectionService ? 7 : 2, progress(name, bytes, total)); Repository.status(context, name + " · " + (total > 0 ? bytes * 100 / total + "%" : format(bytes))); }
    private void check() throws IOException {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("Cancelled");
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastSessionCheck > 500) { JSONObject current = Vault.load(context); if (current == null || !sessionToken.equals(current.optString("token"))) throw new IOException("Pairing changed"); lastSessionCheck = now; }
    }
    private long max() { JSONObject c = Vault.load(context); return c == null ? 0 : Math.min(1073741824L, c.optLong("maxFileBytes", 1073741824L)); }
    void upload(Api api, Uri uri) throws Exception {
        check();
        if (!"content".equals(uri.getScheme())) throw new IllegalArgumentException("Choose a file from the Android file picker");
        String name = null; long size = -1;
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) { name = cursor.getString(0); if (!cursor.isNull(1)) size = cursor.getLong(1); }
        }
        name = FileRules.name(name); if (size > max()) throw new IllegalArgumentException("File exceeds the server limit");
        HttpURLConnection c = api.open("/v1/inbox?name=" + URLEncoder.encode(name, "UTF-8"), "POST", 60000); active = c;
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); long count = 0, last = 0;
        try {
            c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/octet-stream"); if (size >= 0) c.setFixedLengthStreamingMode(size); else c.setChunkedStreamingMode(65536);
            try (InputStream in = context.getContentResolver().openInputStream(uri); OutputStream out = c.getOutputStream()) {
                if (in == null) throw new IOException("File unavailable"); byte[] buffer = new byte[65536]; int n;
                while ((n = in.read(buffer)) != -1) { check(); count += n; if (count > max()) throw new IllegalArgumentException("File exceeds server limit"); out.write(buffer, 0, n); digest.update(buffer, 0, n); if (count - last > 262144) { update("Sending " + name, count, size); last = count; } }
            }
            check(); JSONObject row = Api.response(c).getJSONObject("file");
            if (!FileRules.matches(row.getString("sha256"), digest.digest()) || row.getLong("size") != count || !"received".equals(row.getString("status"))) throw new IOException("Upload verification failed");
            check(); Repository.local(context, "sent", FileRules.id(row.getString("id")), row);
        } finally { c.disconnect(); active = null; }
    }
    void receiveAll(Api api) throws Exception {
        check();
        recover();
        JSONObject state = api.json("/v1/state", null); check(); Repository.state(context, state); JSONArray files = state.getJSONArray("files");
        for (int i = 0; i < files.length(); i++) {
            check(); JSONObject row = files.getJSONObject(i); if (!"to-phone".equals(row.optString("direction"))) continue;
            String id = FileRules.id(row.getString("id")); JSONObject saved = Repository.local(context, "received").optJSONObject(id);
            if (saved != null) { if ("queued".equals(row.optString("status"))) api.json("/v1/files/" + id + "/ack", new JSONObject().put("sha256", saved.getString("sha256"))); continue; }
            if ("queued".equals(row.optString("status"))) download(api, row);
        }
        Notices.waitingFiles(context, 0);
    }
    private void recover() throws Exception {
        JSONObject pendingRows = Repository.local(context, "pending"); Iterator<String> keys = pendingRows.keys();
        while (keys.hasNext()) {
            String id = keys.next(); Uri uri = Uri.parse(pendingRows.getString(id));
            if (!"content".equals(uri.getScheme()) || !"media".equals(uri.getAuthority())) throw new IOException("Invalid local receipt");
            JSONObject saved = Repository.local(context, "received").optJSONObject(id);
            if (saved != null && saved.optBoolean("verified")) {
                ContentValues value = new ContentValues(); value.put(MediaStore.Downloads.IS_PENDING, 0);
                if (context.getContentResolver().update(uri, value, null, null) != 1) throw new IOException("Could not recover verified download");
            } else context.getContentResolver().delete(uri, null, null);
            Repository.remove(context, "pending", id);
        }
    }
    private void download(Api api, JSONObject row) throws Exception {
        String id = FileRules.id(row.getString("id")), name = FileRules.name(row.getString("name")); long expected = row.getLong("size");
        if (expected < 0 || expected > max()) throw new IllegalArgumentException("Incoming file exceeds limit");
        ContentValues values = new ContentValues(); values.put(MediaStore.Downloads.DISPLAY_NAME, name); values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream"); values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LexBridge/"); values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values); if (uri == null) throw new IOException("Cannot create download"); pending = uri;
        // Persist a pending receipt before bytes: process-death recovery can remove its unpublished row.
        boolean committed = false; HttpURLConnection c = null;
        try {
            Repository.local(context, "pending", id, uri.toString());
            c = api.open("/v1/files/" + id + "/content", "GET", 60000); active = c;
            if (c.getResponseCode() != 200) { Api.response(c); throw new IOException("Download unavailable"); }
            if (c.getContentLengthLong() != expected || !row.getString("sha256").equalsIgnoreCase(c.getHeaderField("X-Content-SHA256"))) throw new IOException("Download metadata mismatch");
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); long count = 0, last = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = context.getContentResolver().openOutputStream(uri, "w")) {
                if (out == null) throw new IOException("Cannot write download"); byte[] buffer = new byte[65536]; int n;
                while ((n = in.read(buffer)) != -1) { check(); count += n; if (count > expected || count > max()) throw new IOException("Download exceeded expected size"); digest.update(buffer, 0, n); out.write(buffer, 0, n); if (count - last > 262144) { update("Receiving " + name, count, expected); last = count; } }
                if (count != expected || !FileRules.matches(row.getString("sha256"), digest.digest())) throw new IOException("Download verification failed");
            }
            check(); values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0);
            // Save verified identity before publication; startup recovers publication/ack without duplicating.
            row.put("uri", uri.toString()).put("verified", true); Repository.local(context, "received", id, row);
            if (context.getContentResolver().update(uri, values, null, null) != 1) throw new IOException("Could not publish received file");
            committed = true; pending = null; Repository.remove(context, "pending", id);
            api.json("/v1/files/" + id + "/ack", new JSONObject().put("sha256", row.getString("sha256")));
        } finally {
            if (c != null) c.disconnect(); active = null;
            if (!committed) { JSONObject saved = Repository.local(context, "received").optJSONObject(id); if (saved == null) { context.getContentResolver().delete(uri, null, null); Repository.remove(context, "pending", id); pending = null; } }
        }
    }
    void cancel() { cancelled = true; if (active != null) active.disconnect();  }
}
