package app.lexbridge;
import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import org.json.JSONObject;
import java.util.*;
import java.util.concurrent.*;

public final class TransferService extends Service {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private FileTransfers transfers;
    private int jobs;
    public IBinder onBind(Intent intent) { return null; }
    public void onCreate() { super.onCreate(); transfers = new FileTransfers(this); }
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "cancel".equals(intent.getAction())) { transfers.cancel(); executor.shutdownNow(); stopSelf(); return START_NOT_STICKY; }
        if (intent == null || Vault.load(this) == null) { stopSelf(); return START_NOT_STICKY; }
        startForeground(2, Notices.builder(this, "transfers", "LexBridge transfer", "Preparing files").setOngoing(true).setOnlyAlertOnce(true).setSound(null).build(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        ArrayList<Uri> uris = intent.getParcelableArrayListExtra("uris");
        synchronized (this) { jobs++; }
        executor.execute(() -> {
            try {
                synchronized (FileTransfers.LOCK) {
                    Api api = new Api(Objects.requireNonNull(Vault.load(this)));
                    if (uris != null) for (Uri uri : uris) transfers.upload(api, uri); else transfers.receiveAll(api);
                }
                Repository.status(this, "Transfer complete");
            } catch (Exception e) { Repository.status(this, FileTransfers.safeError(e)); }
            finally { synchronized (this) { if (--jobs == 0) stopSelf(); } }
        }); return START_NOT_STICKY;
    }
    static String format(long bytes) { return FileTransfers.format(bytes); }
    @Override public void onTimeout(int startId, int fgsType) { transfers.cancel(); executor.shutdownNow(); Repository.status(this, "Transfer time limit reached. Retry from Files."); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
    @Override public void onDestroy() { transfers.cancel(); executor.shutdownNow(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
}
