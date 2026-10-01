package app.lexbridge;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;

public final class FileRules {
    private FileRules() {}
    public static String name(String name) {
        if (name == null || name.trim().isEmpty() || name.equals(".") || name.equals("..") || name.length() > 240) throw new IllegalArgumentException("Invalid filename");
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c == '/' || c == '\\' || Character.isISOControl(c)) throw new IllegalArgumentException("Invalid filename");
        }
        return name;
    }
    public static String id(String id) {
        String parsed = UUID.fromString(id).toString();
        if (!parsed.equalsIgnoreCase(id)) throw new IllegalArgumentException("Invalid file ID");
        return parsed;
    }
    public static String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) s.append(String.format(Locale.ROOT, "%02x", b & 255));
        return s.toString();
    }
    public static boolean matches(String expected, byte[] actual) {
        if (expected == null || !expected.matches("[0-9a-fA-F]{64}")) return false;
        byte[] wanted = new byte[32];
        for (int i = 0; i < 32; i++) wanted[i] = (byte) Integer.parseInt(expected.substring(i * 2, i * 2 + 2), 16);
        return MessageDigest.isEqual(wanted, actual);
    }
}
