package app.lexbridge;
import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import org.json.JSONObject;

final class Notices {
    static void channels(Context c) {
        NotificationManager m = c.getSystemService(NotificationManager.class);
        NotificationChannel connection = new NotificationChannel("connection", "Connection status", NotificationManager.IMPORTANCE_LOW); connection.setSound(null, null); connection.setShowBadge(false); m.createNotificationChannel(connection);
        NotificationChannel transfers = new NotificationChannel("transfers", "File transfers", NotificationManager.IMPORTANCE_LOW); transfers.setSound(null, null); m.createNotificationChannel(transfers);
        NotificationChannel alerts = new NotificationChannel("alerts", "Explicit agent alerts", NotificationManager.IMPORTANCE_DEFAULT); alerts.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE); m.createNotificationChannel(alerts);
    }
    static final String OPEN_ALERTS = "app.lexbridge.OPEN_ALERTS";
    static Intent alertsIntent(Context c) { return new Intent(c, MainActivity.class).setAction(OPEN_ALERTS).putExtra("tab", "Alerts").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP); }
    static PendingIntent alertsHome(Context c) { return PendingIntent.getActivity(c, 7, alertsIntent(c), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE); }
    static PendingIntent home(Context c) { return PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE); }
    static Notification.Builder builder(Context c, String channel, String title, String body) {
        channels(c);
        Notification publicVersion = new Notification.Builder(c, channel).setSmallIcon(app.lexbridge.R.drawable.ic_bridge).setContentTitle("LexBridge").setContentText("New activity").build();
        return new Notification.Builder(c, channel).setSmallIcon(app.lexbridge.R.drawable.ic_bridge).setContentTitle(title).setContentText(body).setContentIntent(home(c)).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion);
    }
    static Notification connection(Context c, String message) {
        PendingIntent stop = PendingIntent.getService(c, 1, new Intent(c, ConnectionService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return builder(c, "connection", "LexBridge connection", message).setOngoing(true).setOnlyAlertOnce(true).setSound(null).addAction(new Notification.Action.Builder(null, "Disconnect", stop).build()).build();
    }
    static boolean permitted(Context c, String channel) {
        NotificationManager m = c.getSystemService(NotificationManager.class);
        return (Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) && m.areNotificationsEnabled() && (m.getNotificationChannel(channel) == null || m.getNotificationChannel(channel).getImportance() != NotificationManager.IMPORTANCE_NONE);
    }
    static boolean alert(Context c, JSONObject row) throws Exception {
        if (!permitted(c, "alerts")) return false;
        Notification n = builder(c, "alerts", row.getString("title"), row.getString("body")).setContentIntent(alertsHome(c)).setStyle(new Notification.BigTextStyle().bigText(row.getString("body"))).setAutoCancel(true).build();
        c.getSystemService(NotificationManager.class).notify(row.getString("id"), 3, n); return true;
    }
    static void waitingFiles(Context c, int count) {
        if (count == 0) { c.getSystemService(NotificationManager.class).cancel(4); return; }
        PendingIntent receive = PendingIntent.getForegroundService(c, 2, new Intent(c, TransferService.class).setAction("receive"), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        c.getSystemService(NotificationManager.class).notify(4, builder(c, "transfers", count + " file" + (count == 1 ? "" : "s") + " ready", "Tap Receive to save to Downloads/LexBridge").setOnlyAlertOnce(true).addAction(new Notification.Action.Builder(null, "Receive", receive).build()).build());
    }
}
