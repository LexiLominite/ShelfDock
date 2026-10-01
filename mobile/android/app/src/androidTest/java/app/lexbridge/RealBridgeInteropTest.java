package app.lexbridge;

import android.app.Activity;
import android.graphics.Bitmap;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.app.NotificationManager;
import android.content.*;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import static org.junit.Assert.*;

/** Optional Node interoperability fixture. Private code enters via run-as stdin, never arguments. */
@RunWith(AndroidJUnit4.class)
public class RealBridgeInteropTest {
    @Test public void nativeClientExchangesFilesAndExplicitAlertWithRealNodeBridge() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File privateInput = new File(context.getFilesDir(), "interop-pairing.json");
        Assume.assumeTrue("Root must supply the private synthetic interop fixture", privateInput.isFile());
        JSONObject config;
        try (InputStream in = new FileInputStream(privateInput)) { config = new JSONObject(Api.bounded(in, 65536)); }
        privateInput.delete();
        String endpoint = UrlPolicy.normalize(config.getString("endpoint"));
        // Only the explicitly reversed local synthetic Node service is permitted here.
        assertEquals("http://127.0.0.1:18475", endpoint);
        String expectedText = config.optString("expectedFileText", "LexBridge native interoperability download\n");
        String expectedTitle = config.optString("expectedAlertTitle", "Native interoperability check");
        JSONObject original = Vault.load(context); Activity activity = null; Uri upload = null;
        try {
            Repository.reset(context); Notices.channels(context);
            Api unauthenticated = new Api(endpoint);
            assertEquals(1, unauthenticated.json("/v1/health", null).getInt("protocolVersion"));
            JSONObject paired = unauthenticated.json("/v1/pair", new JSONObject().put("code", config.getString("code")).put("deviceName", "Android interoperability fixture"));
            paired.put("endpoint", endpoint); assertTrue("Missing scoped credential", !paired.optString("token").isEmpty()); Vault.save(context, paired); config.remove("code");
            Api api = new Api(Vault.load(context));
            ContentValues values = new ContentValues(); values.put(MediaStore.Downloads.DISPLAY_NAME, "phone-to-desktop.txt"); values.put(MediaStore.Downloads.MIME_TYPE, "text/plain"); values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LexBridge/"); values.put(MediaStore.Downloads.IS_PENDING, 1);
            upload = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values); assertNotNull(upload);
            try (OutputStream out = context.getContentResolver().openOutputStream(upload, "w")) { out.write("LexBridge native interoperability upload\n".getBytes(StandardCharsets.UTF_8)); }
            values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0); context.getContentResolver().update(upload, values, null, null);
            new FileTransfers(context).upload(api, upload); assertEquals(1, Repository.local(context, "sent").length());
            Repository.connected(context, true);
            activity = InstrumentationRegistry.getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            long deadline = System.currentTimeMillis() + 60000; JSONObject received = null, alert = null;
            while (System.currentTimeMillis() < deadline) {
                JSONObject rows = Repository.local(context, "received"); Iterator<String> ids = rows.keys(); while (ids.hasNext()) { JSONObject row = rows.optJSONObject(ids.next()); if (row != null && row.optBoolean("verified")) received = row; }
                JSONObject alerts = Repository.local(context, "alerts"); Iterator<String> alertIds = alerts.keys(); while (alertIds.hasNext()) { JSONObject saved = alerts.optJSONObject(alertIds.next()); if (saved != null && expectedTitle.equals(saved.getJSONObject("row").optString("title")) && saved.optBoolean("acked")) alert = saved; }
                if (received != null && alert != null) break; Thread.sleep(100);
            }
            assertNotNull("Node file not received and verified before deadline", received); assertNotNull("Explicit Node alert not persisted and acknowledged", alert);
            try (InputStream in = context.getContentResolver().openInputStream(Uri.parse(received.getString("uri")))) { assertEquals(expectedText, new String(in.readAllBytes(), StandardCharsets.UTF_8)); }
            JSONObject state = api.json("/v1/state", null); boolean fileAck = false, alertAck = false;
            JSONArray files = state.getJSONArray("files"); for (int i = 0; i < files.length(); i++) { JSONObject row = files.getJSONObject(i); if (received.getString("id").equals(row.getString("id"))) fileAck = "received".equals(row.getString("status")); }
            JSONArray alerts = state.getJSONArray("notifications"); for (int i = 0; i < alerts.length(); i++) { JSONObject row = alerts.getJSONObject(i); if (alert.getJSONObject("row").getString("id").equals(row.getString("id"))) alertAck = "received".equals(row.getString("status")) || "displayed".equals(row.getString("status")); }
            assertTrue("Node file ack not recorded", fileAck); assertTrue("Node alert ack not recorded", alertAck);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync(); capture(context, "interop-files.png");
            Activity shown = activity; InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> clickButton(shown.getWindow().getDecorView(), "Alerts"));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync(); capture(context, "interop-alerts.png");
        } finally {
            Repository.connected(context, false); context.stopService(new Intent(context, ConnectionService.class)); context.stopService(new Intent(context, TransferService.class));
            if (activity != null) { Activity finished = activity; InstrumentationRegistry.getInstrumentation().runOnMainSync(finished::finish); }
            if (upload != null) context.getContentResolver().delete(upload, null, null);
            JSONObject received = Repository.local(context, "received"); Iterator<String> ids = received.keys(); while (ids.hasNext()) { JSONObject row = received.optJSONObject(ids.next()); if (row != null) context.getContentResolver().delete(Uri.parse(row.getString("uri")), null, null); }
            context.getSystemService(NotificationManager.class).cancelAll(); Repository.reset(context); Vault.clear(context); if (original != null) Vault.save(context, original); privateInput.delete();
        }
    }
    private static boolean clickButton(View view, String label) {
        if (view instanceof Button && label.contentEquals(((Button) view).getText())) { view.performClick(); return true; }
        if (view instanceof ViewGroup) { ViewGroup group = (ViewGroup) view; for (int i = 0; i < group.getChildCount(); i++) if (clickButton(group.getChildAt(i), label)) return true; }
        return false;
    }
    private static void capture(Context context, String name) throws Exception {
        Bitmap screenshot = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        if (screenshot != null) { try (OutputStream out = new FileOutputStream(new File(context.getFilesDir(), name))) { screenshot.compress(Bitmap.CompressFormat.PNG, 100, out); } finally { screenshot.recycle(); } }
    }
}
