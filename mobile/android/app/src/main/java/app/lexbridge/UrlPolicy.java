package app.lexbridge;

import java.net.URI;
import java.util.Locale;

/** All request endpoints pass this gate; redirects are always disabled. */
public final class UrlPolicy {
    private UrlPolicy() {}
    public static String normalize(String raw) {
        try {
            URI u = new URI(raw.trim());
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            String host = u.getHost();
            if (!scheme.equals("http") && !scheme.equals("https")) throw new IllegalArgumentException();
            if (host == null || u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null) throw new IllegalArgumentException();
            if (u.getRawPath() != null && !u.getRawPath().isEmpty() && !u.getRawPath().equals("/")) throw new IllegalArgumentException();
            if (u.getPort() == 0 || u.getPort() > 65535 || u.getPort() < -1) throw new IllegalArgumentException();
            host = host.toLowerCase(Locale.ROOT);
            if (!privateLiteral(host) && !(scheme.equals("https") && host.matches("[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.ts\\.net"))) throw new IllegalArgumentException();
            if (host.equals("localhost")) host = "127.0.0.1";
            return scheme + "://" + host + (u.getPort() == -1 ? "" : ":" + u.getPort());
        } catch (Exception e) {
            throw new IllegalArgumentException("Use a literal Tailscale (100.64–100.127) or loopback address, or HTTPS with a .ts.net hostname. Enter only the server URL and port.");
        }
    }
    static boolean privateLiteral(String host) {
        if (host.equals("localhost") || host.equals("[::1]") || host.equals("::1")) return true;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            n[i] = Integer.parseInt(parts[i]);
            if (n[i] > 255) return false;
        }
        return n[0] == 127 || (n[0] == 100 && n[1] >= 64 && n[1] <= 127);
    }
}
