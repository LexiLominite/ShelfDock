package app.lexbridge;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(16,23,25), CARD = Color.rgb(27,37,40), TEAL = Color.rgb(98,220,195), WHITE = Color.rgb(231,242,239), MUTED = Color.rgb(157,177,177);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private LinearLayout root, body;
    private String tab = "Files";
    private boolean pairing;
    private ArrayList<Uri> share = new ArrayList<>();
    private final BroadcastReceiver updates = new BroadcastReceiver() { public void onReceive(Context c, Intent i) { if (Vault.load(MainActivity.this) != null) renderHome(); } };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG);
        Notices.channels(this); readNavigation(getIntent()); parseShare(getIntent()); render();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 3);
    }
    @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); readNavigation(intent); parseShare(intent); render(); }
    private void readNavigation(Intent intent) {
        if (intent != null && Notices.OPEN_ALERTS.equals(intent.getAction()) && "Alerts".equals(intent.getStringExtra("tab"))) tab = "Alerts";
    }
    private void parseShare(Intent intent) {
        share.clear(); if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction())) { Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (u != null && "content".equals(u.getScheme())) share.add(u); }
        else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) { ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (list != null) for (Uri u : list) if ("content".equals(u.getScheme())) share.add(u); }
    }
    @Override protected void onStart() {
        super.onStart(); registerReceiver(updates, new IntentFilter(Repository.UPDATE), getPackageName() + ".INTERNAL", null, Build.VERSION.SDK_INT >= 33 ? Context.RECEIVER_NOT_EXPORTED : 0);
        if (Vault.load(this) != null && Repository.connected(this)) startForegroundService(new Intent(this, ConnectionService.class));
    }
    @Override protected void onStop() { unregisterReceiver(updates); super.onStop(); }
    @Override protected void onDestroy() { worker.shutdownNow(); super.onDestroy(); }
    private int dp(int n) { return (int)(n * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private TextView text(String text, int size, int color) { TextView t = new TextView(this); t.setText(text); t.setTextSize(size); t.setTextColor(color); t.setPadding(0, dp(5), 0, dp(5)); return t; }
    private Button button(String label, Runnable action) { Button b = new Button(this); b.setText(label); b.setTextColor(TEAL); b.setAllCaps(false); b.setOnClickListener(v -> action.run()); return b; }
    private void base(String subtitle) {
        root = column(); root.setPadding(dp(22), dp(22), dp(22), dp(12)); root.setBackgroundColor(BG);
        root.addView(text("LEXBRIDGE", 12, TEAL)); root.addView(text("Your devices, connected", 27, WHITE)); root.addView(text(subtitle, 14, MUTED));
        ScrollView scroll = new ScrollView(this); body = column(); body.setPadding(0, dp(16), 0, 0); scroll.addView(body); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        root.setOnApplyWindowInsetsListener((v, insets) -> { int top, bottom; if (Build.VERSION.SDK_INT >= 30) { android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars()); top = bars.top; bottom = bars.bottom; } else { top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom(); } v.setPadding(dp(22), dp(14) + top, dp(22), dp(10) + bottom); return insets; });
    }
    private void render() { if (Vault.load(this) == null) renderPair(); else renderHome(); }
    private void renderPair() {
        base("A private companion for your desktop");
        body.addView(text("Pair with your desktop", 23, WHITE)); body.addView(text("Connect Tailscale on both devices. Enter the server URL and the one-time pairing code created on your desktop. While connected, incoming files automatically save to Downloads / LexBridge.", 15, MUTED));
        EditText endpoint = new EditText(this); endpoint.setSingleLine(true); endpoint.setHint("http://100.64.0.1:18474"); endpoint.setTextColor(WHITE); endpoint.setHintTextColor(MUTED); endpoint.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); body.addView(endpoint);
        EditText code = new EditText(this); code.setSingleLine(true); code.setHint("One-time pairing code"); code.setTextColor(WHITE); code.setHintTextColor(MUTED); code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); body.addView(code);
        EditText name = new EditText(this); name.setSingleLine(true); name.setHint("Phone name"); name.setText(Build.MODEL); name.setTextColor(WHITE); name.setHintTextColor(MUTED); body.addView(name);
        TextView error = text("", 14, TEAL); body.addView(error);
        Button pair = button("Pair securely", () -> {
            if (pairing) return;
            final String url;
            try { url = UrlPolicy.normalize(endpoint.getText().toString()); } catch (Exception e) { error.setText(e.getMessage()); return; }
            String pairingCode = code.getText().toString().trim(), deviceName = name.getText().toString().trim();
            if (pairingCode.isEmpty() || deviceName.isEmpty() || deviceName.length() > 64) { error.setText("Enter a pairing code and a phone name (up to 64 characters)."); return; }
            pairing = true; error.setText("Connecting…");
            worker.execute(() -> {
                try {
                    Api api = new Api(url); JSONObject health = api.json("/v1/health", null); if (health.getInt("protocolVersion") != 1) throw new Exception("This bridge version is not supported");
                    JSONObject creds = api.json("/v1/pair", new JSONObject().put("code", pairingCode).put("deviceName", deviceName));
                    FileRules.id(creds.getString("deviceId")); if (creds.getInt("protocolVersion") != 1 || creds.getString("token").isEmpty() || creds.getLong("maxFileBytes") <= 0) throw new Exception("Invalid pairing response");
                    creds.put("endpoint", url); Vault.save(this, creds); Repository.connected(this, true);
                    runOnUiThread(() -> { pairing = false; code.setText(""); startForegroundService(new Intent(this, ConnectionService.class)); renderHome(); });
                } catch (Exception e) { runOnUiThread(() -> { pairing = false; error.setText(e instanceof Api.ApiError || e instanceof IllegalArgumentException ? e.getMessage() : "Could not pair. Check the URL, Tailscale connection and pairing code."); }); }
            });
        }); body.addView(pair); body.addView(text("Credentials stay encrypted in Android Keystore. Alerts are sent only when you explicitly request them from an agent.", 13, MUTED));
    }
    private void renderHome() {
        if (Vault.load(this) == null) return;
        String status = getSharedPreferences("data", 0).getString("status", "Ready to connect"); base(status);
        LinearLayout tabs = new LinearLayout(this); for (String label : new String[]{"Files", "Alerts", "Settings"}) { Button b = button(label, () -> { tab = label; renderHome(); }); if (tab.equals(label)) b.setTextColor(WHITE); tabs.addView(b, new LinearLayout.LayoutParams(0, -2, 1)); } body.addView(tabs);
        if (!share.isEmpty()) {
            body.addView(text(share.size() + " shared file" + (share.size() == 1 ? "" : "s") + " ready to send", 17, WHITE));
            body.addView(button("Send shared files to desktop", () -> { transfer(new ArrayList<>(share)); share.clear(); renderHome(); })); body.addView(button("Dismiss shared files", () -> { share.clear(); renderHome(); }));
        }
        switch (tab) { case "Alerts": alerts(); break; case "Settings": settings(); break; default: files(); }
    }
    private void files() {
        body.addView(text("Files", 23, WHITE)); body.addView(text("Send to Desktop, or receive into Downloads / LexBridge.", 14, MUTED));
        body.addView(button("Choose files to send", () -> { Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); startActivityForResult(picker, 1); }));
        body.addView(button("Receive waiting files", () -> startForegroundService(new Intent(this, TransferService.class).setAction("receive"))));
        JSONObject state = Repository.state(this); JSONArray remote = state.optJSONArray("files"); JSONObject local = Repository.local(this, "received");
        body.addView(text("Received", 18, TEAL)); int received = 0;
        if (remote != null) for (int i = remote.length() - 1; i >= 0; i--) { JSONObject row = remote.optJSONObject(i); if (row != null && "to-phone".equals(row.optString("direction"))) { received++; fileCard(row, local.optJSONObject(row.optString("id"))); } }
        HashSet<String> shown = new HashSet<>(); if (remote != null) for (int i = 0; i < remote.length(); i++) shown.add(remote.optJSONObject(i).optString("id"));
        Iterator<String> receivedKeys = local.keys(); while (receivedKeys.hasNext()) { String id = receivedKeys.next(); if (!shown.contains(id)) { JSONObject row = local.optJSONObject(id); if (row != null) { received++; fileCard(row, row); } } }
        if (received == 0) body.addView(text("Files from your desktop will appear here.", 14, MUTED));
        body.addView(text("Sent", 18, TEAL)); int sent = 0;
        if (remote != null) for (int i = remote.length() - 1; i >= 0; i--) { JSONObject row = remote.optJSONObject(i); if (row != null && "from-phone".equals(row.optString("direction"))) { sent++; fileCard(row, null); } }
        JSONObject sentRows = Repository.local(this, "sent"); Iterator<String> sentKeys = sentRows.keys(); while (sentKeys.hasNext()) { String id = sentKeys.next(); if (!shown.contains(id)) { JSONObject row = sentRows.optJSONObject(id); if (row != null) { sent++; fileCard(row, null); } } }
        if (sent == 0) body.addView(text("Choose a file or share it to LexBridge from another app.", 14, MUTED));
    }
    private void fileCard(JSONObject row, JSONObject saved) {
        LinearLayout card = column(); card.setBackgroundColor(CARD); card.setPadding(dp(14), dp(10), dp(14), dp(10)); LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.setMargins(0, dp(5), 0, dp(5)); body.addView(card, lp);
        card.addView(text(row.optString("name"), 16, WHITE)); String status = saved != null ? "Verified · saved to Downloads" : "from-phone".equals(row.optString("direction")) ? "Received by desktop" : "Ready to receive";
        card.addView(text(TransferService.format(row.optLong("size")) + " · " + status, 12, MUTED));
        if (saved != null) card.addView(button("Open file", () -> open(saved.optString("uri"), row.optString("name"))));
    }
    private void open(String stored, String name) {
        try {
            Uri uri = Uri.parse(stored); if (!"content".equals(uri.getScheme()) || !"media".equals(uri.getAuthority())) throw new IllegalArgumentException();
            String mime = getContentResolver().getType(uri); if (mime == null || "application/octet-stream".equals(mime)) { String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(name); mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase(Locale.ROOT)); } if (mime == null) mime = "application/octet-stream";
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); intent.setClipData(ClipData.newRawUri("LexBridge file", uri)); startActivity(Intent.createChooser(intent, "Open received file"));
        } catch (Exception e) { new AlertDialog.Builder(this).setMessage("The file cannot be opened. Find it in Downloads / LexBridge, or install an app that supports this file type.").setPositiveButton("OK", null).show(); }
    }
    private void alerts() {
        body.addView(text("Explicit alerts", 23, WHITE)); body.addView(text("Only alerts you ask an agent to send appear here.", 14, MUTED)); JSONObject alerts = Repository.local(this, "alerts"); ArrayList<JSONObject> rows = new ArrayList<>(); Iterator<String> keys = alerts.keys(); while (keys.hasNext()) { JSONObject saved = alerts.optJSONObject(keys.next()); if (saved != null && saved.optJSONObject("row") != null) rows.add(saved.optJSONObject("row")); } rows.sort((a, b) -> b.optString("createdAt").compareTo(a.optString("createdAt")));
        if (rows.isEmpty()) body.addView(text("No alerts yet.", 15, MUTED));
        for (JSONObject row : rows) { LinearLayout card = column(); card.setPadding(dp(14), dp(12), dp(14), dp(12)); card.setBackgroundColor(CARD); LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.setMargins(0, dp(6), 0, dp(6)); body.addView(card, lp); card.addView(text(row.optString("source") + " · " + row.optString("severity"), 12, TEAL)); card.addView(text(row.optString("title"), 18, WHITE)); card.addView(text(row.optString("body"), 15, WHITE)); card.addView(text(row.optString("createdAt"), 11, MUTED)); }
    }
    private void settings() {
        JSONObject credential = Vault.load(this); body.addView(text("Connection", 23, WHITE)); body.addView(text(credential.optString("endpoint"), 15, MUTED));
        Switch toggle = new Switch(this); toggle.setText("Background connection"); toggle.setTextColor(WHITE); toggle.setChecked(Repository.connected(this)); toggle.setOnCheckedChangeListener((b, checked) -> { Repository.connected(this, checked); if (checked) startForegroundService(new Intent(this, ConnectionService.class)); else { stopService(new Intent(this, ConnectionService.class)); Repository.status(this, "Disconnected"); } }); body.addView(toggle);
        body.addView(text("Keeps the private connection available for explicit alerts. Incoming files automatically save to Downloads / LexBridge. Send files from the picker or Android share menu. You can disconnect at any time.", 14, MUTED));
        body.addView(text("If the desktop is unavailable: confirm Tailscale is connected on both devices, the bridge is running, and this private URL is correct. Battery restrictions may delay reconnecting after Android stops the app.", 14, MUTED));
        body.addView(button("Notification settings", () -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()))));
        body.addView(button("Refresh server state", this::refresh));
        body.addView(button("Forget pairing", () -> new AlertDialog.Builder(this).setTitle("Forget this desktop?").setMessage("Pair again with a new code to reconnect. Received files remain in Downloads.").setNegativeButton("Cancel", null).setPositiveButton("Forget", (d, w) -> { stopService(new Intent(this, ConnectionService.class)); stopService(new Intent(this, TransferService.class)); Repository.connected(this, false); Vault.clear(this); Repository.reset(this); renderPair(); }).show()));
        body.addView(text("LexBridge 0.1.0 · Private notifications on lock screen · No conversation scanning", 12, MUTED));
    }
    private void refresh() { worker.execute(() -> { try { JSONObject creds = Vault.load(this); if (creds != null) Repository.state(this, new Api(creds).json("/v1/state", null)); } catch (Exception e) { Repository.status(this, "Desktop unavailable. Check your connection."); } }); }
    private void transfer(ArrayList<Uri> uris) {
        Intent i = new Intent(this, TransferService.class).putParcelableArrayListExtra("uris", uris).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); if (!uris.isEmpty()) { ClipData clips = ClipData.newRawUri("Files to send", uris.get(0)); for (int j = 1; j < uris.size(); j++) clips.addItem(new ClipData.Item(uris.get(j))); i.setClipData(clips); } startForegroundService(i);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data); if (request != 1 || result != RESULT_OK || data == null) return;
        ArrayList<Uri> selected = new ArrayList<>(); if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) selected.add(data.getClipData().getItemAt(i).getUri()); else if (data.getData() != null) selected.add(data.getData());
        for (Uri uri : selected) { try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) {} }
        if (!selected.isEmpty()) new AlertDialog.Builder(this).setTitle("Send to desktop?").setMessage(selected.size() + " selected file" + (selected.size() == 1 ? "" : "s") + " will be copied to Desktop.").setNegativeButton("Cancel", null).setPositiveButton("Send", (d, w) -> transfer(selected)).show();
    }
}
