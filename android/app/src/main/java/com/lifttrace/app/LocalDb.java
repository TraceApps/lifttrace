package com.lifttrace.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;

import java.io.File;

/**
 * Opens the app's local database (the JS side's Capacitor SQLite file) for
 * the native workers.
 *
 * Always read-write, even just to read: when the app was stopped in the
 * middle of a write, SQLite leaves a "hot" journal that has to be rolled
 * back before anything can be read, and a read-only connection can't do
 * that. It fails with SQLITE_READONLY_ROLLBACK on every read until the app
 * itself opens the database again, so the reminder worker read every
 * setting as off and sent no reminders in the meantime.
 *
 * A failed read is an error, never a setting.
 */
public final class LocalDb {
    public static final String FILENAME = "lifttraceSQLite.db";

    private LocalDb() {}

    /** The database, or null when the app hasn't created it yet. Throws when it can't be opened. */
    public static SQLiteDatabase open(Context context) {
        File file = context.getDatabasePath(FILENAME);
        if (!file.exists()) return null;
        return SQLiteDatabase.openDatabase(file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
    }

    /** A read that failed only because the settings table isn't there yet (first launch): the same as unset. */
    public static boolean isMissingTable(Exception e) {
        String m = e.getMessage();
        return m != null && m.contains("no such table");
    }
}
