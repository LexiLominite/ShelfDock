package app.lexbridge;

import android.content.Context;
import android.content.Intent;
import android.app.Activity;
import android.app.Notification;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import android.app.NotificationManager;
import android.service.notification.StatusBarNotification;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

/** Synthetic loopback server only: no live desktop, pairing code, or phone needed. */
@RunWith(AndroidJUnit4.class)
public class ProtocolFixtureTest {
    private Context context;
    private JSONObject original;
    private Fixture fixture;
    private Activity activity;
    @Before public void prepare() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext(); original = Vault.load(context);
        Notices.channels(context); Repository.reset(context); fixture = new Fixture();
        JSONObject paired = new Api(fixture.endpoint()).json("/v1/pair", new JSONObject().put("code", "synthetic-only").put("deviceName", "Fixture"));
        paired.put("endpoint", fixture.endpoint()); Vault.save(context, paired);
        assertEquals("synthetic-device-token", Vault.load(context).getString("token"));
        String raw = context.getSharedPreferences("vault", 0).getString("credential", ""); assertFalse(raw.contains("synthetic-device-token"));
    }
    @After public void cleanup() throws Exception {
        Repository.connected(context, false); context.stopService(new Intent(context, ConnectionService.class)); context.stopService(new Intent(context, TransferService.class));
        if (activity != null) InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> activity.finish());
        context.getSystemService(NotificationManager.class).cancelAll();
        JSONObject received = Repository.local(context, "received"); Iterator<String> keys = received.keys();
        while (keys.hasNext()) { JSONObject row = received.optJSONObject(keys.next()); if (row != null) context.getContentResolver().delete(Uri.parse(row.getString("uri")), null, null); }
        if (fixture != null) fixture.close(); Repository.reset(context); Vault.clear(context); if (original != null) Vault.save(context, original);
    }
    @Test public void alertNotificationTapOpensAlertsWithoutDuplicateCards() throws Exception {
        Repository.connected(context, false);
        JSONObject row = new JSONObject().put("id", Fixture.ALERT_ID).put("title", "Tap route fixture").put("body", "Explicit fixture alert").put("source", "fixture").put("severity", "info").put("createdAt", "2026-10-02T00:00:00Z");
        Repository.local(context, "alerts", Fixture.ALERT_ID, new JSONObject().put("row", row).put("attempted", true).put("displayed", true).put("acked", true));
        assertTrue("Notification permission required for tap fixture", Notices.alert(context, row));
        Notices.alert(context, row);
        Notification posted = null; int copies = 0;
        for (StatusBarNotification card : context.getSystemService(NotificationManager.class).getActiveNotifications()) if (Fixture.ALERT_ID.equals(card.getTag())) { copies++; posted = card.getNotification(); }
        assertEquals("Duplicate notification cards", 1, copies); assertNotNull(posted);
        // Cold launch consumes the same whitelisted intent produced by the notification factory.
        activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Notices.alertsIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertTrue(hasText(activity.getWindow().getDecorView(), "Explicit alerts")));
        // Actual notification PendingIntent tap must also route the existing Activity through onNewIntent.
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertTrue(clickButton(activity.getWindow().getDecorView(), "Files")));
        posted.contentIntent.send(); InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertTrue("Alert tap opened the wrong tab", hasText(activity.getWindow().getDecorView(), "Explicit alerts")));
    }
    private static boolean hasText(View view, String text) {
        if (view instanceof TextView && text.contentEquals(((TextView) view).getText())) return true;
        if (view instanceof ViewGroup) { ViewGroup group = (ViewGroup) view; for (int i = 0; i < group.getChildCount(); i++) if (hasText(group.getChildAt(i), text)) return true; }
        return false;
    }
    private static boolean clickButton(View view, String text) {
        if (view instanceof Button && text.contentEquals(((Button) view).getText())) { view.performClick(); return true; }
        if (view instanceof ViewGroup) { ViewGroup group = (ViewGroup) view; for (int i = 0; i < group.getChildCount(); i++) if (clickButton(group.getChildAt(i), text)) return true; }
        return false;
    }
    @Test public void foregroundConnectionReceivesFileAndExplicitSseAlertOnce() throws Exception {
        fixture.alerts = true; Repository.connected(context, true);
        // Launch only the synthetic emulator app to satisfy Android user-visible FGS start.
        activity = InstrumentationRegistry.getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        long deadline = System.currentTimeMillis() + 12000;
        while (System.currentTimeMillis() < deadline && (fixture.alertAcks.get() < 1 || fixture.acks.get() < 1 || fixture.eventRequests.get() < 1)) Thread.sleep(100);
        assertTrue("SSE was not connected", fixture.eventRequests.get() > 0);
        assertEquals(1, fixture.contentRequests.get()); assertEquals(1, fixture.acks.get()); assertEquals(1, fixture.alertAcks.get());
        assertTrue(Repository.local(context, "alerts").getJSONObject(Fixture.ALERT_ID).getBoolean("attempted"));
        assertTrue(Repository.local(context, "received").has(Fixture.FILE_ID));
        int copies = 0; for (StatusBarNotification n : context.getSystemService(NotificationManager.class).getActiveNotifications()) if (Fixture.ALERT_ID.equals(n.getTag())) copies++;
        assertTrue("Duplicate notification cards", copies <= 1);
    }
    @Test public void receiveVerifiesPublishesAcksAndDeduplicatesThenUploads() throws Exception {
        Api api = new Api(Vault.load(context)); FileTransfers transfers = new FileTransfers(context);
        transfers.receiveAll(api); transfers.receiveAll(api);
        assertEquals(1, fixture.contentRequests.get()); assertEquals(1, fixture.acks.get());
        JSONObject row = Repository.local(context, "received").getJSONObject(Fixture.FILE_ID); assertTrue(row.getBoolean("verified"));
        Uri uri = Uri.parse(row.getString("uri")); try (InputStream in = context.getContentResolver().openInputStream(uri)) { assertArrayEquals(Fixture.BYTES, in.readAllBytes()); }
        assertEquals(0, Repository.local(context, "pending").length());
        transfers.upload(api, uri); assertEquals(1, Repository.local(context, "sent").length()); assertArrayEquals(Fixture.BYTES, fixture.uploaded);
        assertFalse(fixture.credentialInUri); assertTrue(fixture.authenticatedRequests.get() >= 4);
    }
    @Test public void failedAckRetriesWithoutDuplicateDownload() throws Exception {
        fixture.failAck = true; FileTransfers transfers = new FileTransfers(context); Api api = new Api(Vault.load(context));
        try { transfers.receiveAll(api); fail("Synthetic failed ack accepted"); } catch (Api.ApiError expected) { assertEquals(503, expected.status); }
        assertTrue(Repository.local(context, "received").has(Fixture.FILE_ID)); assertEquals(0, Repository.local(context, "pending").length());
        fixture.failAck = false; transfers.receiveAll(api);
        assertEquals(1, fixture.contentRequests.get()); assertEquals(1, fixture.acks.get());
    }
    @Test public void mismatchedBytesNeverPublishOrAcknowledge() throws Exception {
        fixture.corrupt = true;
        try { new FileTransfers(context).receiveAll(new Api(Vault.load(context))); fail("Corrupt file accepted"); } catch (IOException expected) {}
        assertEquals(0, fixture.acks.get()); assertEquals(0, Repository.local(context, "received").length()); assertEquals(0, Repository.local(context, "pending").length());
    }
    @Test public void stateAbove64KiBRemainsReadableWithinBound() throws Exception {
        fixture.largeState = true;
        JSONObject state = new Api(Vault.load(context)).json("/v1/state", null);
        assertEquals(70000, state.getString("fixturePadding").length());
    }
    @Test public void redirectCannotForwardToken() throws Exception {
        fixture.redirect = true;
        try { new Api(Vault.load(context)).json("/v1/state", null); fail("Redirect accepted"); } catch (Api.ApiError expected) { assertEquals(302, expected.status); }
        assertEquals(1, fixture.authenticatedRequests.get());
    }
    private static final class Fixture implements AutoCloseable {
        static final String ALERT_ID = "123e4567-e89b-12d3-a456-426614174003";
        static final String FILE_ID = "123e4567-e89b-12d3-a456-426614174000", SENT_ID = "123e4567-e89b-12d3-a456-426614174001";
        static final byte[] BYTES = "LexBridge fixture\n".getBytes(StandardCharsets.UTF_8);
        final ServerSocket socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        final AtomicInteger contentRequests = new AtomicInteger(), acks = new AtomicInteger(), authenticatedRequests = new AtomicInteger(), alertAcks = new AtomicInteger(), eventRequests = new AtomicInteger();
        volatile boolean corrupt, redirect, closed, credentialInUri, failAck, largeState, alerts; volatile byte[] uploaded;
        final String hash = FileRules.hex(MessageDigest.getInstance("SHA-256").digest(BYTES));
        final Thread thread;
        Fixture() throws Exception { thread = new Thread(this::loop); thread.start(); }
        String endpoint() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        JSONObject row(String id, String direction, String status) throws Exception { return new JSONObject().put("id", id).put("name", "lexbridge-fixture-" + FILE_ID + ".txt").put("size", BYTES.length).put("sha256", hash).put("direction", direction).put("status", status).put("createdAt", "2026-10-02T00:00:00Z"); }
        void loop() {
            while (!closed) try (Socket peer = socket.accept()) { serve(peer); } catch (Exception e) { if (!closed) throw new RuntimeException(e); }
        }
        void serve(Socket peer) throws Exception {
            BufferedInputStream in = new BufferedInputStream(peer.getInputStream()); String request = line(in); String route = request.split(" ")[1]; Map<String,String> headers = new HashMap<>();
            for (String line; !(line = line(in)).isEmpty();) { int separator = line.indexOf(':'); if (separator > 0) headers.put(line.substring(0, separator).toLowerCase(Locale.ROOT), line.substring(separator + 1).trim()); }
            int length = Integer.parseInt(headers.getOrDefault("content-length", "0")); byte[] body = in.readNBytes(length);
            credentialInUri |= route.contains("token") || route.contains("synthetic-device");
            if (!route.equals("/v1/pair")) { if (!"Bearer synthetic-device-token".equals(headers.get("authorization"))) { respond(peer, 401, "{}", null); return; } authenticatedRequests.incrementAndGet(); }
            if (route.equals("/v1/pair")) respond(peer, 200, new JSONObject().put("deviceId", "123e4567-e89b-12d3-a456-426614174002").put("token", "synthetic-device-token").put("protocolVersion", 1).put("serverName", "Fixture").put("maxFileBytes", 1073741824).toString(), null);
            else if (route.equals("/v1/state")) {
                if (redirect) respond(peer, 302, "{}", "Location: https://example.com/\r\n");
                else respond(peer, 200, new JSONObject().put("protocolVersion", 1).put("serverName", "Fixture").put("files", new JSONArray().put(row(FILE_ID, "to-phone", acks.get() > 0 ? "received" : "queued"))).put("notifications", alerts ? new JSONArray().put(new JSONObject().put("id", ALERT_ID).put("title", "Explicit synthetic alert").put("body", "Only the fixture sent this message").put("source", "fixture").put("severity", "info").put("createdAt", "2026-10-02T00:00:00Z").put("status", "queued")) : new JSONArray()).put("fixturePadding", largeState ? "x".repeat(70000) : "").toString(), null);
            } else if (route.equals("/v1/events")) {
                eventRequests.incrementAndGet(); OutputStream out = peer.getOutputStream(); byte[] event = "event: state\ndata: {\"type\":\"state-changed\"}\n\n".getBytes(StandardCharsets.UTF_8);
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: " + event.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.write(event); out.flush();
            } else if (route.equals("/v1/notifications/" + ALERT_ID + "/ack")) {
                assertTrue(new JSONObject(new String(body, StandardCharsets.UTF_8)).has("displayed")); alertAcks.incrementAndGet(); respond(peer, 200, "{\"status\":\"received\"}", null);
            } else if (route.endsWith("/content")) {
                contentRequests.incrementAndGet(); byte[] payload = BYTES.clone(); if (corrupt) payload[0] ^= 1;
                OutputStream out = peer.getOutputStream(); out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + payload.length + "\r\nX-Content-SHA256: " + hash + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); out.write(payload); out.flush();
            } else if (route.endsWith("/ack")) { if (failAck) { respond(peer, 503, "{\"error\":\"Synthetic retry\"}", null); return; } assertEquals(hash, new JSONObject(new String(body, StandardCharsets.UTF_8)).getString("sha256")); acks.incrementAndGet(); respond(peer, 200, "{\"status\":\"received\"}", null); }
            else if (route.startsWith("/v1/inbox?name=")) { uploaded = body; respond(peer, 200, new JSONObject().put("file", row(SENT_ID, "from-phone", "received")).toString(), null); }
            else respond(peer, 404, "{}", null);
        }
        String line(InputStream in) throws IOException { ByteArrayOutputStream out = new ByteArrayOutputStream(); int b; while ((b = in.read()) != -1 && b != '\n') { if (b != '\r') out.write(b); if (out.size() > 8192) throw new IOException("Bad fixture request"); } return out.toString("US-ASCII"); }
        void respond(Socket peer, int status, String json, String extra) throws Exception { byte[] bytes = json.getBytes(StandardCharsets.UTF_8); OutputStream out = peer.getOutputStream(); out.write(("HTTP/1.1 " + status + " Fixture\r\nContent-Type: application/json\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n" + (extra == null ? "" : extra) + "\r\n").getBytes(StandardCharsets.US_ASCII)); out.write(bytes); out.flush(); }
        public void close() throws Exception { closed = true; socket.close(); thread.join(1000); }
    }
}
