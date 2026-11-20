package ai.deepseek.tablet;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 会话存储的原生实现：一个 SQLiteOpenHelper 管 chat.db（版本 1）。
 *
 * <p>为什么要有这一层：WebView 里的 IndexedDB 读写要经过 renderer 进程，长会话每次落盘都要
 * 序列化整条会话、跨进程传字节，还会被配额/清理策略影响；换成同进程的 SQLite 后，
 * 列会话列表只读摘要列（不碰 messages 表），单条消息更新也不用重写整个会话。
 *
 * <p>表结构（与 {@code work/2026-11-17-deepseek-tablet/native-sqlite-design.md} 第二节一致）：
 * <pre>
 * sessions(id, title, created_at, updated_at, summary_json, file_ids, message_count)
 * messages(session_id, seq, id, payload)          -- 单条 Message 的完整 JSON
 * files(id, mime, size, data)                     -- 附件原件（BLOB）
 * meta(k, v)                                      -- 迁移标记
 * </pre>
 *
 * <p>约定：
 * <ul>
 *   <li>所有写操作都在事务里；失败整体回滚，不留半条会话</li>
 *   <li>消息写入是「先删该会话全部消息行、再按 seq 重插」，配合 INSERT OR REPLACE 保证幂等</li>
 *   <li>读写方法都加 synchronized：HTTP 服务是多线程的，而 SQLiteDatabase 只有一条主连接，
 *       让同一时刻只有一个线程在库里跑，避免两个 persist 交错或读写抢连接时出现
 *       「database is locked」与事务嵌套异常</li>
 * </ul>
 */
final class ChatDatabase extends SQLiteOpenHelper {

    private static final String TAG = "DsChatDb";

    static final String DB_NAME = "chat.db";
    static final int VERSION = 1;

    private static final String TABLE_SESSIONS = "sessions";
    private static final String TABLE_MESSAGES = "messages";
    private static final String TABLE_FILES = "files";
    private static final String TABLE_META = "meta";

    private static final String COL_ID = "id";
    private static final String COL_TITLE = "title";
    private static final String COL_CREATED_AT = "created_at";
    private static final String COL_UPDATED_AT = "updated_at";
    private static final String COL_SUMMARY_JSON = "summary_json";
    private static final String COL_FILE_IDS = "file_ids";
    private static final String COL_MESSAGE_COUNT = "message_count";
    private static final String COL_SESSION_ID = "session_id";
    private static final String COL_SEQ = "seq";
    private static final String COL_PAYLOAD = "payload";
    private static final String COL_MIME = "mime";
    private static final String COL_SIZE = "size";
    private static final String COL_DATA = "data";
    private static final String COL_META_KEY = "k";
    private static final String COL_META_VALUE = "v";

    /** meta 表里标记「IndexedDB 已经搬过来了」 */
    private static final String META_MIGRATED = "migrated";
    private static final String META_MIGRATED_AT = "migrated_at";

    private static final String EMPTY_ARRAY = "[]";

    ChatDatabase(Context context) {
        this(context, DB_NAME);
    }

    private ChatDatabase(Context context, String name) {
        super(appContext(context), name, null, VERSION);
    }

    /** 只持有 Application context，避免把 Activity 泄漏到整个进程生命周期。 */
    private static Context appContext(Context context) {
        Context app = context.getApplicationContext();
        return app != null ? app : context;
    }

    // ---------------------------------------------------------------- 建表

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        // 开了外键删除会话时消息才会级联清掉（删除语句里仍然显式删一遍，见 delete）
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        createSchema(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // 版本 1 是初始版本，正常不会走到这里。将来的升级必须原地 ALTER TABLE 补列，
        // 绝不允许 DROP —— 那等于把用户的聊天记录删掉。
        Log.w(TAG, "onUpgrade " + oldVersion + " -> " + newVersion + "：只补建缺失的表，不删数据");
        createSchema(db);
    }

    /** 幂等建表：onCreate 与（将来的）onUpgrade 共用。 */
    private static void createSchema(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS sessions ("
                + "id TEXT PRIMARY KEY NOT NULL,"
                + "title TEXT NOT NULL,"
                + "created_at INTEGER NOT NULL,"
                + "updated_at INTEGER NOT NULL,"
                + "summary_json TEXT NOT NULL,"
                + "file_ids TEXT NOT NULL DEFAULT '[]',"
                + "message_count INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE IF NOT EXISTS messages ("
                + "session_id TEXT NOT NULL,"
                + "seq INTEGER NOT NULL,"
                + "id TEXT NOT NULL,"
                + "payload TEXT NOT NULL,"
                + "PRIMARY KEY (session_id, seq),"
                + "FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq)");
        db.execSQL("CREATE TABLE IF NOT EXISTS files ("
                + "id TEXT PRIMARY KEY NOT NULL,"
                + "mime TEXT NOT NULL DEFAULT '',"
                + "size INTEGER NOT NULL DEFAULT 0,"
                + "data BLOB NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS meta ("
                + "k TEXT PRIMARY KEY NOT NULL,"
                + "v TEXT NOT NULL)");
    }

    // ---------------------------------------------------------------- 读

    /**
     * 会话列表：只读 sessions 表，一行一个摘要，不碰 messages。
     *
     * <p>summary_json 里除 SessionSummary 的四个字段外还带着 rootMessageId（如果有），
     * 否则重新打开会话时「线性老数据」与「空会话」会分辨不出来（undefined 与 null 语义不同）。
     *
     * @return 按 updated_at 倒序的摘要数组；坏行跳过，不让一行脏数据顶掉整个列表
     */
    synchronized JSONArray summaries() throws JSONException {
        JSONArray result = new JSONArray();
        Cursor cursor = getReadableDatabase().query(TABLE_SESSIONS,
                new String[] {COL_SUMMARY_JSON}, null, null, null, null,
                COL_UPDATED_AT + " DESC");
        try {
            while (cursor.moveToNext()) {
                String summary = cursor.getString(0);
                if (summary == null || summary.trim().isEmpty()) {
                    continue;
                }
                try {
                    result.put(new JSONObject(summary));
                } catch (JSONException broken) {
                    Log.w(TAG, "跳过一条摘要损坏的会话：" + broken);
                }
            }
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
        return result;
    }

    /**
     * 读完整会话：摘要来自 sessions 表，消息逐行拼回来。
     *
     * @return 会话 JSON；不存在返回 null
     */
    synchronized JSONObject loadSession(String id) throws JSONException {
        SQLiteDatabase db = getReadableDatabase();
        String summary = null;
        Cursor cursor = db.query(TABLE_SESSIONS, new String[] {COL_SUMMARY_JSON},
                COL_ID + " = ?", new String[] {id}, null, null, null);
        try {
            if (cursor.moveToFirst()) {
                summary = cursor.getString(0);
            }
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
        if (summary == null) {
            return null;
        }
        JSONObject session;
        try {
            session = new JSONObject(summary);
        } catch (JSONException broken) {
            // 摘要坏了也不编造数据：当成「读不到」，上层会走错误提示
            Log.w(TAG, "会话摘要损坏：" + id + " " + broken);
            return null;
        }
        JSONArray messages = new JSONArray();
        Cursor rows = db.query(TABLE_MESSAGES, new String[] {COL_PAYLOAD},
                COL_SESSION_ID + " = ?", new String[] {id}, null, null, COL_SEQ + " ASC");
        try {
            while (rows.moveToNext()) {
                String payload = rows.getString(0);
                if (payload == null || payload.trim().isEmpty()) {
                    continue;
                }
                try {
                    messages.put(new JSONObject(payload));
                } catch (JSONException broken) {
                    Log.w(TAG, "跳过一条消息损坏的会话：" + id + " seq=" + rows.getPosition());
                }
            }
        } finally {
            HttpUtil.closeQuietly(rows);
        }
        session.put("messages", messages);
        return session;
    }

    synchronized byte[] getFile(String id) {
        Cursor cursor = getReadableDatabase().query(TABLE_FILES, new String[] {COL_DATA},
                COL_ID + " = ?", new String[] {id}, null, null, null);
        try {
            if (!cursor.moveToFirst()) {
                return null;
            }
            return cursor.getBlob(0);
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
    }

    /**
     * 附件原本的 MIME（存进 files.mime）。
     * 响应体的 Content-Type 按契约固定 octet-stream，真实类型靠这个另走一个响应头。
     */
    synchronized String getFileMime(String id) {
        Cursor cursor = getReadableDatabase().query(TABLE_FILES, new String[] {COL_MIME},
                COL_ID + " = ?", new String[] {id}, null, null, null);
        try {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
    }

    /** 各表条数 + 标记，给 /__ds_db/state 与迁移校验用。 */
    synchronized JSONObject counts() throws JSONException {
        JSONObject result = new JSONObject();
        SQLiteDatabase db = getReadableDatabase();
        result.put("schemaVersion", VERSION);
        result.put("sessions", countRows(db, TABLE_SESSIONS));
        result.put("messages", countRows(db, TABLE_MESSAGES));
        result.put("files", countRows(db, TABLE_FILES));
        result.put("migrated", isMigrated());
        return result;
    }

    synchronized boolean isMigrated() {
        Cursor cursor = getReadableDatabase().query(TABLE_META, new String[] {COL_META_VALUE},
                COL_META_KEY + " = ?", new String[] {META_MIGRATED}, null, null, null);
        try {
            return cursor.moveToFirst() && "1".equals(cursor.getString(0));
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
    }

    // ---------------------------------------------------------------- 写

    /**
     * 写一条会话（摘要 + 全部消息行），一个事务。
     *
     * <p>幂等：sessions 用 INSERT OR REPLACE，消息先按 session_id 全删再按 seq 重插。
     * 注意 REPLACE 会先删旧行，外键级联会把旧消息一并带走 —— 这条语句之后必须重新插消息，
     * 顺序不能反。
     *
     * @param session 完整会话 JSON（含 messages）
     * @param fileIds 该会话引用的附件 id；null 按空数组
     */
    synchronized void saveSession(JSONObject session, JSONArray fileIds) throws JSONException {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            writeSession(db, session, fileIds);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * 改标题。只能 UPDATE，不能用 INSERT OR REPLACE：
     * REPLACE 会删掉整行，外键级联会把这条会话的所有消息删干净。
     *
     * @return true 表示会话存在并且已更新
     */
    synchronized boolean rename(String id, String title) throws JSONException {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            JSONObject summary = readSummary(db, id);
            if (summary == null) {
                return false;
            }
            summary.put(COL_TITLE, title);
            ContentValues row = new ContentValues();
            row.put(COL_TITLE, title);
            // 摘要单独存一份，改名要保持两处一致；updated_at 不动，与 IndexedDB 版行为一致
            row.put(COL_SUMMARY_JSON, summary.toString());
            boolean updated = db.update(TABLE_SESSIONS, row, COL_ID + " = ?", new String[] {id}) > 0;
            db.setTransactionSuccessful();
            return updated;
        } finally {
            db.endTransaction();
        }
    }

    /**
     * 删会话：会话行 + 消息行 + 已无任何会话引用的附件原件。
     * 远端文件不删（同一服务端文件可能被多个会话复用）。
     *
     * @return true 表示确实删掉了一条
     */
    synchronized boolean delete(String id) throws JSONException {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            JSONArray fileIds = readFileIds(db, id);
            db.delete(TABLE_MESSAGES, COL_SESSION_ID + " = ?", new String[] {id});
            int removed = db.delete(TABLE_SESSIONS, COL_ID + " = ?", new String[] {id});
            if (removed > 0 && fileIds != null) {
                // 剩余会话引用到的附件集合；file_ids 是冗余存的 JSON，只扫这一列，不扫消息
                Set<String> stillUsed = collectReferencedFileIds(db);
                for (int index = 0; index < fileIds.length(); index++) {
                    String fileId = fileIds.optString(index, "");
                    if (!fileId.isEmpty() && !stillUsed.contains(fileId)) {
                        db.delete(TABLE_FILES, COL_ID + " = ?", new String[] {fileId});
                    }
                }
            }
            db.setTransactionSuccessful();
            return removed > 0;
        } finally {
            db.endTransaction();
        }
    }

    /** 存附件原件（二进制单独上传，不进会话 JSON）。 */
    synchronized void putFile(String id, String mime, byte[] data) {
        ContentValues row = new ContentValues();
        row.put(COL_ID, id);
        row.put(COL_MIME, mime == null ? "" : mime);
        row.put(COL_SIZE, data == null ? 0 : data.length);
        row.put(COL_DATA, data == null ? new byte[0] : data);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.insertWithOnConflict(TABLE_FILES, null, row, SQLiteDatabase.CONFLICT_REPLACE);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * 迁移用：一整个批次在一个事务里 upsert，最后打上迁移标记。
     * 中途失败整批回滚，下次启动重跑（每条会话本身也是幂等的）。
     *
     * @return 实际写入的会话数（id 缺失的条目跳过）
     */
    synchronized int importSessions(JSONArray sessions, JSONObject fileIdsById) throws JSONException {
        int imported = 0;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (int index = 0; index < sessions.length(); index++) {
                JSONObject session = sessions.optJSONObject(index);
                if (session == null) {
                    continue;
                }
                String id = session.optString(COL_ID, "");
                if (id.isEmpty()) {
                    continue;
                }
                JSONArray fileIds = fileIdsById == null ? null : fileIdsById.optJSONArray(id);
                writeSession(db, session, fileIds);
                imported++;
            }
            markMigratedRow(db);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return imported;
    }

    synchronized void markMigrated() {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            markMigratedRow(db);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /** 清空全部数据，仅迁移调试用（/__ds_db/reset）。 */
    synchronized void reset() {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.delete(TABLE_MESSAGES, null, null);
            db.delete(TABLE_SESSIONS, null, null);
            db.delete(TABLE_FILES, null, null);
            db.delete(TABLE_META, null, null);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    // ---------------------------------------------------------------- 内部

    /** 调用方负责开事务。 */
    private static void writeSession(SQLiteDatabase db, JSONObject session, JSONArray fileIds)
            throws JSONException {
        String id = session.optString(COL_ID, "");
        if (id.isEmpty()) {
            throw new JSONException("session.id 不能为空");
        }
        String title = session.optString(COL_TITLE, "");
        long createdAt = session.optLong("createdAt", 0L);
        long updatedAt = session.optLong("updatedAt", createdAt);
        JSONArray messages = session.optJSONArray("messages");

        ContentValues row = new ContentValues();
        row.put(COL_ID, id);
        row.put(COL_TITLE, title);
        row.put(COL_CREATED_AT, createdAt);
        row.put(COL_UPDATED_AT, updatedAt);
        row.put(COL_SUMMARY_JSON, summaryJson(session, id, title, createdAt, updatedAt));
        row.put(COL_FILE_IDS, (fileIds == null ? new JSONArray() : fileIds).toString());
        // 先按 0 写，插完消息再按实际行数补；正常路径不会差，异常数据也不会把条数写错
        row.put(COL_MESSAGE_COUNT, 0);
        db.insertWithOnConflict(TABLE_SESSIONS, null, row, SQLiteDatabase.CONFLICT_REPLACE);

        // REPLACE 已经把旧行（含级联消息）删掉了，这里再删一次是为了幂等（REPLACE 之外还有首次写入）
        db.delete(TABLE_MESSAGES, COL_SESSION_ID + " = ?", new String[] {id});

        int inserted = 0;
        if (messages != null) {
            for (int index = 0; index < messages.length(); index++) {
                JSONObject message = messages.optJSONObject(index);
                if (message == null) {
                    continue;
                }
                ContentValues messageRow = new ContentValues();
                messageRow.put(COL_SESSION_ID, id);
                messageRow.put(COL_SEQ, index);
                messageRow.put(COL_ID, message.optString(COL_ID, ""));
                messageRow.put(COL_PAYLOAD, message.toString());
                db.insertWithOnConflict(TABLE_MESSAGES, null, messageRow,
                        SQLiteDatabase.CONFLICT_REPLACE);
                inserted++;
            }
        }
        if (inserted > 0) {
            ContentValues patch = new ContentValues();
            patch.put(COL_MESSAGE_COUNT, inserted);
            db.update(TABLE_SESSIONS, patch, COL_ID + " = ?", new String[] {id});
        }
    }

    /**
     * 摘要是 sessions.summary_json 的全部内容：四个 SessionSummary 字段
     * + 可选的 rootMessageId（区分「线性老数据 undefined」与「空会话 null」）。
     */
    private static String summaryJson(JSONObject session, String id, String title, long createdAt,
            long updatedAt) throws JSONException {
        JSONObject summary = new JSONObject();
        summary.put(COL_ID, id);
        summary.put(COL_TITLE, title);
        summary.put(COL_CREATED_AT, createdAt);
        summary.put(COL_UPDATED_AT, updatedAt);
        if (session.has("rootMessageId")) {
            summary.put("rootMessageId",
                    session.isNull("rootMessageId") ? JSONObject.NULL : session.get("rootMessageId"));
        }
        return summary.toString();
    }

    private static JSONObject readSummary(SQLiteDatabase db, String id) throws JSONException {
        Cursor cursor = db.query(TABLE_SESSIONS, new String[] {COL_SUMMARY_JSON},
                COL_ID + " = ?", new String[] {id}, null, null, null);
        try {
            if (!cursor.moveToFirst()) {
                return null;
            }
            String summary = cursor.getString(0);
            return summary == null ? null : new JSONObject(summary);
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
    }

    private static JSONArray readFileIds(SQLiteDatabase db, String id) {
        Cursor cursor = db.query(TABLE_SESSIONS, new String[] {COL_FILE_IDS},
                COL_ID + " = ?", new String[] {id}, null, null, null);
        try {
            if (!cursor.moveToFirst()) {
                return null;
            }
            String raw = cursor.getString(0);
            if (raw == null || raw.trim().isEmpty()) {
                return new JSONArray();
            }
            try {
                return new JSONArray(raw);
            } catch (JSONException broken) {
                Log.w(TAG, "会话的 file_ids 不是合法 JSON：" + id);
                return new JSONArray();
            }
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
    }

    /** 除被删会话之外，其他会话还引用着哪些附件 id。 */
    private static Set<String> collectReferencedFileIds(SQLiteDatabase db) {
        Set<String> referenced = new LinkedHashSet<>();
        Cursor cursor = db.query(TABLE_SESSIONS, new String[] {COL_FILE_IDS},
                null, null, null, null, null);
        try {
            while (cursor.moveToNext()) {
                String raw = cursor.getString(0);
                if (raw == null || EMPTY_ARRAY.equals(raw.trim())) {
                    continue;
                }
                try {
                    JSONArray ids = new JSONArray(raw);
                    for (int index = 0; index < ids.length(); index++) {
                        String fileId = ids.optString(index, "");
                        if (!fileId.isEmpty()) {
                            referenced.add(fileId);
                        }
                    }
                } catch (JSONException broken) {
                    Log.w(TAG, "跳过 file_ids 损坏的会话行");
                }
            }
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
        return referenced;
    }

    private static long countRows(SQLiteDatabase db, String table) {
        Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM " + table, null);
        try {
            return cursor.moveToFirst() ? cursor.getLong(0) : 0L;
        } finally {
            HttpUtil.closeQuietly(cursor);
        }
    }

    /** 打标记；migrated_at 只在第一次写，保留原始迁移时间。 */
    private static void markMigratedRow(SQLiteDatabase db) {
        putMeta(db, META_MIGRATED, "1", true);
        putMeta(db, META_MIGRATED_AT, String.valueOf(System.currentTimeMillis()), false);
    }

    private static void putMeta(SQLiteDatabase db, String key, String value, boolean replace) {
        ContentValues row = new ContentValues();
        row.put(COL_META_KEY, key);
        row.put(COL_META_VALUE, value);
        db.insertWithOnConflict(TABLE_META, null, row,
                replace ? SQLiteDatabase.CONFLICT_REPLACE : SQLiteDatabase.CONFLICT_IGNORE);
    }
}
