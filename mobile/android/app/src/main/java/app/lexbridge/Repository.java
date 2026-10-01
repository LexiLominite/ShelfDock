package app.lexbridge;
import android.content.*;
import org.json.*;

final class Repository {
    static final String UPDATE = "app.lexbridge.UPDATE";
    static synchronized JSONObject state(Context c) {
        try { return new JSONObject(c.getSharedPreferences("data", 0).getString("state", "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    static synchronized void state(Context c, JSONObject json) throws Exception {
        if (!c.getSharedPreferences("data", 0).edit().putString("state", json.toString()).commit()) throw new Exception("Could not persist server state");
        changed(c);
    }
    static synchronized JSONObject local(Context c, String key) {
        try { return new JSONObject(c.getSharedPreferences("data", 0).getString(key, "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    static synchronized void local(Context c, String key, String id, Object row) throws Exception {
        JSONObject json = local(c, key); json.put(id, row);
        if (!c.getSharedPreferences("data", 0).edit().putString(key, json.toString()).commit()) throw new Exception("Could not persist delivery receipt");
        changed(c);
    }
    static synchronized void remove(Context c, String key, String id) throws Exception {
        JSONObject json = local(c, key); json.remove(id);
        if (!c.getSharedPreferences("data", 0).edit().putString(key, json.toString()).commit()) throw new Exception("Could not persist delivery cleanup");
    }
    static void status(Context c, String status) { c.getSharedPreferences("data", 0).edit().putString("status", status).apply(); changed(c); }
    static void changed(Context c) { c.sendBroadcast(new Intent(UPDATE).setPackage(c.getPackageName())); }
    static boolean connected(Context c) { return c.getSharedPreferences("settings", 0).getBoolean("background", true); }
    static void connected(Context c, boolean enabled) { c.getSharedPreferences("settings", 0).edit().putBoolean("background", enabled).commit(); }
    static void reset(Context c) { c.getSharedPreferences("data", 0).edit().clear().commit(); }
}
