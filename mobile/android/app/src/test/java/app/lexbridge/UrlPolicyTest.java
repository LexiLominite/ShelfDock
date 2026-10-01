package app.lexbridge;
import org.junit.Test;
import static org.junit.Assert.*;
public class UrlPolicyTest {
    @Test public void tailscaleBoundariesAndLoopback() {
        for (String host : new String[]{"100.64.0.0", "100.127.255.255", "127.0.0.1", "127.9.1.2", "[::1]"}) assertEquals("http://" + host + ":18474", UrlPolicy.normalize("http://" + host + ":18474/"));
        assertEquals("http://127.0.0.1", UrlPolicy.normalize("http://localhost"));
    }
    @Test public void onlyPrivateHttps() {
        assertEquals("https://spark.tail123.ts.net", UrlPolicy.normalize("https://SPARK.tail123.ts.net/"));
        assertEquals("https://100.100.1.1", UrlPolicy.normalize("https://100.100.1.1"));
        reject("https://example.com"); reject("https://evilts.net"); reject("https://spark.ts.net.evil.com");
    }
    @Test public void rejectsPublicLanAndAmbiguousAddresses() {
        for (String host : new String[]{"100.63.255.255", "100.128.0.0", "192.168.1.1", "10.0.0.1", "8.8.8.8", "127.1", "2130706433", "0177.0.0.1", "100.064.0.1", "100.64.0.256", "spark.tail123.ts.net", "[::ffff:127.0.0.1]"}) reject("http://" + host);
    }
    @Test public void rejectsCredentialAndPathSmuggling() {
        for (String value : new String[]{"http://token@100.64.1.1", "http://100.64.1.1?token=secret", "http://100.64.1.1#token", "http://100.64.1.1/v1", "http://100.64.1.1:0", "http://100.64.1.1:65536", "ftp://100.64.1.1", "http://100.64.1.1\\@evil.com", "http://100.64.1.1/%2f"}) reject(value);
    }
    private void reject(String value) { try { UrlPolicy.normalize(value); fail("Accepted unsafe URL"); } catch (IllegalArgumentException expected) {} }
}
