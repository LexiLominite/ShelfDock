package app.lexbridge;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

final class Api {
    final String endpoint, token;
    Api(JSONObject credential) { endpoint = UrlPolicy.normalize(credential.optString("endpoint")); token = credential.optString("token"); }
    Api(String endpoint) { this.endpoint = UrlPolicy.normalize(endpoint); token = ""; }
    HttpURLConnection open(String path, String method, int timeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(UrlPolicy.normalize(endpoint) + path).openConnection();
        c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(timeout); c.setRequestMethod(method); c.setRequestProperty("Accept", "application/json");
        if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }
    JSONObject json(String path, JSONObject body) throws Exception {
        HttpURLConnection c = open(path, body == null ? "GET" : "POST", 30000);
        try {
            if (body != null) {
                byte[] data = body.toString().getBytes(StandardCharsets.UTF_8); if (data.length > 65536) throw new IOException("Request too large");
                c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); c.setFixedLengthStreamingMode(data.length);
                try (OutputStream out = c.getOutputStream()) { out.write(data); }
            }
            return response(c, path.equals("/v1/state") ? 2097152 : 65536);
        } finally { c.disconnect(); }
    }
    static JSONObject response(HttpURLConnection c) throws Exception { return response(c, 65536); }
    static JSONObject response(HttpURLConnection c, int limit) throws Exception {
        int status = c.getResponseCode();
        InputStream input = status >= 200 && status < 300 ? c.getInputStream() : c.getErrorStream();
        String content;
        try (InputStream in = input) { content = in == null ? "{}" : bounded(in, limit); }
        JSONObject json;
        try { json = new JSONObject(content); } catch (Exception e) { throw new IOException("Server returned an invalid response (" + status + ")"); }
        if (status < 200 || status >= 300) throw new ApiError(status, json.optString("error", "Request failed (" + status + ")"));
        return json;
    }
    static String bounded(InputStream in, int limit) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int n;
        while ((n = in.read(buffer)) != -1) { if (out.size() + n > limit) throw new IOException("Server response exceeded limit"); out.write(buffer, 0, n); }
        return out.toString("UTF-8");
    }
    static final class ApiError extends IOException { final int status; ApiError(int status, String message) { super(message); this.status = status; } }
}
