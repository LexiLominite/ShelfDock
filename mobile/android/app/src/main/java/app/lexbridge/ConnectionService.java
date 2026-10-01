package app.lexbridge;
import android.app.*;
import android.content.*;
import android.os.*;
import org.json.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

public final class ConnectionService extends Service {
    private volatile boolean running;
    private volatile HttpURLConnection stream;
    private Thread worker;
    private FileTransfers transfers;
    public void onCreate() { super.onCreate(); transfers = new FileTransfers(this); }
    public IBinder onBind(Intent intent) { return null; }
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) { Repository.connected(this, false); stopSelf(); return START_NOT_STICKY; }
        if (Vault.load(this) == null || !Repository.connected(this)) { stopSelf(); return START_NOT_STICKY; }
        int types = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        if (Build.VERSION.SDK_INT >= 34) types |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING;
        startForeground(1, Notices.connection(this, "Connecting to your desktop"), types);
        if (!running) { running = true; worker = new Thread(this::loop, "LexBridge-events"); worker.start(); }
        return START_STICKY;
    }
    private void loop() {
        long retry = 1000;
        while (running) {
            JSONObject creds = Vault.load(this);
            if (creds == null || !Repository.connected(this)) break;
            try {
                Api api = new Api(creds); refresh(api);
                Repository.status(this, "Connected"); getSystemService(NotificationManager.class).notify(1, Notices.connection(this, "Connected · explicit alerts only"));
                stream = api.open("/v1/events", "GET", 45000); stream.setRequestProperty("Accept", "text/event-stream");
                int code = stream.getResponseCode(); if (code != 200) { Api.response(stream); throw new IOException("Event connection failed"); }
                if (stream.getContentType() == null || !stream.getContentType().startsWith("text/event-stream")) throw new IOException("Invalid event stream");
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream.getInputStream(), StandardCharsets.UTF_8))) {
                    String line; String event = ""; int eventBytes = 0;
                    while (running && (line = reader.readLine()) != null) {
                        eventBytes += line.length(); if (eventBytes > 65536) throw new IOException("Event exceeded limit");
                        if (line.startsWith("event:")) event = line.substring(6).trim();
                        if (line.isEmpty()) { if (event.equals("state")) refresh(api); event = ""; eventBytes = 0; }
                    }
                }
                retry = 1000;
            } catch (Api.ApiError e) {
                if (e.status == 401 || e.status == 403) { Repository.status(this, "Pairing revoked. Pair again in Settings."); Repository.connected(this, false); break; }
                Repository.status(this, "Connection interrupted · retrying");
            } catch (Exception e) { if (running) Repository.status(this, "Desktop unavailable · retrying"); }
            finally { if (stream != null) stream.disconnect(); stream = null; }
            if (running) { try { Thread.sleep(retry); } catch (InterruptedException e) { break; } retry = Math.min(30000, retry * 2); }
        }
        running = false; stopSelf();
    }
    private void checkSession(Api api) throws Exception {
        JSONObject current = Vault.load(this);
        if (!running || !Repository.connected(this) || current == null || !current.optString("token").equals(api.token) || !current.optString("endpoint").equals(api.endpoint)) throw new InterruptedIOException("Connection stopped");
    }
    private void refresh(Api api) throws Exception {
        checkSession(api);
        JSONObject state = api.json("/v1/state", null); if (state.getInt("protocolVersion") != 1) throw new IOException("Incompatible bridge protocol");
        checkSession(api); Repository.state(this, state);
        JSONArray alerts = state.optJSONArray("notifications");
        if (alerts != null) for (int i = 0; i < alerts.length(); i++) {
            checkSession(api); JSONObject row = alerts.getJSONObject(i); String id = FileRules.id(row.getString("id"));
            JSONObject stored = Repository.local(this, "alerts").optJSONObject(id);
            if (stored == null) {
                // Persist first; stable notification tag makes retries replace the same card.
                stored = new JSONObject().put("row", row).put("displayed", false).put("attempted", false);
                Repository.local(this, "alerts", id, stored);
            }
            if (!stored.optBoolean("attempted")) {
                checkSession(api); boolean displayed = Notices.alert(this, row);
                stored.put("displayed", displayed).put("attempted", true); Repository.local(this, "alerts", id, stored);
            }
            if (!stored.optBoolean("acked")) {
                checkSession(api); api.json("/v1/notifications/" + id + "/ack", new JSONObject().put("displayed", stored.optBoolean("displayed")));
                checkSession(api); stored.put("acked", true); Repository.local(this, "alerts", id, stored);
            }
        }
        checkSession(api); int queued = 0; JSONArray files = state.optJSONArray("files");
        if (files != null) for (int i = 0; i < files.length(); i++) { JSONObject f = files.getJSONObject(i); if ("to-phone".equals(f.optString("direction")) && "queued".equals(f.optString("status"))) queued++; }
        Notices.waitingFiles(this, queued);
        if (queued > 0 || Repository.local(this, "pending").length() > 0) {
            try { synchronized (FileTransfers.LOCK) { transfers.receiveAll(api); } }
            catch (Exception e) { Repository.status(this, FileTransfers.safeError(e)); throw e; }
            getSystemService(NotificationManager.class).cancel(7);
            checkSession(api); Repository.status(this, "Connected");
        }
    }
    public void onDestroy() {
        running = false; transfers.cancel(); if (stream != null) stream.disconnect(); if (worker != null) worker.interrupt(); getSystemService(NotificationManager.class).cancel(7); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
}
