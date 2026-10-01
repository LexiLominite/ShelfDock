package app.lexbridge;
import org.junit.Test;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;
public class FileRulesTest {
    @Test public void keepsHumanNames() { assertEquals("Résumé 2026.pdf", FileRules.name("Résumé 2026.pdf")); }
    @Test public void rejectsTraversalAndControls() {
        for (String value : new String[]{"", " ", ".", "..", "../test", "dir/file", "dir\\file", "bad\nname", "bad\u0000name"}) {
            try { FileRules.name(value); fail("Accepted unsafe filename"); } catch (IllegalArgumentException expected) {}
        }
    }
    @Test public void hashesExactBytesAndRejectsTruncation() throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest("abc".getBytes(StandardCharsets.UTF_8));
        String hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assertEquals(hex, FileRules.hex(digest)); assertTrue(FileRules.matches(hex.toUpperCase(), digest)); assertFalse(FileRules.matches(hex.substring(1), digest)); assertFalse(FileRules.matches("0".repeat(64), digest)); assertFalse(FileRules.matches(null, digest));
    }
    @Test public void uuidCannotEscapeRoute() {
        assertEquals("123e4567-e89b-12d3-a456-426614174000", FileRules.id("123e4567-e89b-12d3-a456-426614174000"));
        for (String id : new String[]{"../content", "1-1-1-1-1", "123e4567-e89b-12d3-a456-426614174000/other"}) try { FileRules.id(id); fail("Accepted unsafe ID"); } catch (IllegalArgumentException expected) {}
    }
}
