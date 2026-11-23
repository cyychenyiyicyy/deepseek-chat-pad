package ai.deepseek.tablet;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores credentials in the app sandbox with an Android Keystore key. */
final class SshCredentialStore {
    private static final String KEY_ALIAS = "chatpad-ssh-credentials-v1";
    private static final String[] FIELDS = {"password", "privateKey", "passphrase", "launchToken"};
    private final SharedPreferences records;

    SshCredentialStore(Context context) {
        records = context.getSharedPreferences(KEY_ALIAS, Context.MODE_PRIVATE);
    }

    synchronized void fill(String identity, JSONObject config) throws GeneralSecurityException, IOException, JSONException {
        byte[] aad = identity.getBytes(StandardCharsets.UTF_8);
        String stored = records.getString(recordKey(aad), null);
        if (stored == null) throw new GeneralSecurityException("Missing credentials");
        byte[] bytes = Base64.decode(stored, Base64.NO_WRAP);
        if (bytes.length <= 12) throw new GeneralSecurityException("Invalid credentials");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, bytes, 0, 12));
        cipher.updateAAD(aad);
        byte[] plain = cipher.doFinal(bytes, 12, bytes.length - 12);
        try {
            JSONObject secrets = new JSONObject(new String(plain, StandardCharsets.UTF_8));
            for (String field : FIELDS) config.put(field, secrets.optString(field));
        } finally {
            Arrays.fill(plain, (byte) 0);
        }
    }

    synchronized void save(String identity, JSONObject config) throws GeneralSecurityException, IOException, JSONException {
        byte[] aad = identity.getBytes(StandardCharsets.UTF_8);
        JSONObject secrets = new JSONObject();
        for (String field : FIELDS) secrets.put(field, config.optString(field));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(aad);
        byte[] plain = secrets.toString().getBytes(StandardCharsets.UTF_8);
        try {
            byte[] iv = cipher.getIV();
            if (iv.length != 12) throw new GeneralSecurityException("Invalid IV");
            byte[] sealed = cipher.doFinal(plain);
            byte[] bytes = Arrays.copyOf(iv, iv.length + sealed.length);
            System.arraycopy(sealed, 0, bytes, iv.length, sealed.length);
            if (!records.edit().putString(recordKey(aad), Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()) {
                throw new IOException("Could not store credentials");
            }
        } finally {
            Arrays.fill(plain, (byte) 0);
        }
    }

    synchronized void forget(String identity) throws GeneralSecurityException, IOException {
        if (!records.edit().remove(recordKey(identity.getBytes(StandardCharsets.UTF_8))).commit()) {
            throw new IOException("Could not delete credentials");
        }
    }

    private static String recordKey(byte[] identity) throws GeneralSecurityException {
        return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(identity), Base64.NO_WRAP);
    }

    private static SecretKey key(boolean create) throws GeneralSecurityException, IOException {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        SecretKey existing = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        if (!create) throw new GeneralSecurityException("Missing Keystore key");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
