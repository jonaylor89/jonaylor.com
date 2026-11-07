package app.mypeople.data

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import java.io.File

/** Small seam so the exact SQL engine/transactions can also run against SQLite in JVM tests. */
internal interface GraphSql : AutoCloseable {
    fun execute(sql: String, args: List<Any?> = emptyList())
    fun query(sql: String, args: List<Any?> = emptyList()): List<List<String?>>
    fun blobs(sql: String, args: List<Any?> = emptyList()): List<Pair<String,ByteArray>>
    fun begin()
    fun commit()
    fun rollback()
    val inTransaction: Boolean
}

internal class AndroidGraphSql(file: File) : GraphSql {
    private val database = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.CREATE_IF_NECESSARY)
    private val statements = object : LinkedHashMap<String, SQLiteStatement>(32, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, SQLiteStatement>): Boolean {
            if (size <= 32) return false
            eldest.value.close(); return true
        }
    }
    init {
        database.enableWriteAheadLogging()
        database.execSQL("PRAGMA synchronous=FULL")
        database.execSQL("PRAGMA foreign_keys=ON")
        database.rawQuery("PRAGMA busy_timeout=10000",null).use { it.moveToFirst() }
    }
    override val inTransaction get() = database.inTransaction()
    override fun begin() = database.beginTransactionNonExclusive()
    override fun commit() { database.setTransactionSuccessful(); database.endTransaction() }
    override fun rollback() = database.endTransaction()
    override fun execute(sql: String, args: List<Any?>) {
        val statement = statements.getOrPut(sql) { database.compileStatement(sql) }
        statement.clearBindings()
        args.forEachIndexed { index, value -> when (value) {
            null -> statement.bindNull(index + 1)
            is Number -> if (value is Double || value is Float) statement.bindDouble(index + 1, value.toDouble()) else statement.bindLong(index + 1, value.toLong())
            is ByteArray -> statement.bindBlob(index + 1,value)
            is Boolean -> statement.bindLong(index + 1, if (value) 1 else 0)
            else -> statement.bindString(index + 1, value.toString())
        } }
        statement.execute()
    }
    override fun query(sql: String, args: List<Any?>): List<List<String?>> = database.rawQuery(sql, args.map { it?.toString() }.toTypedArray()).use { cursor ->
        buildList { while (cursor.moveToNext()) add(List(cursor.columnCount) { if (cursor.isNull(it)) null else cursor.getString(it) }) }
    }
    override fun blobs(sql: String,args: List<Any?>): List<Pair<String,ByteArray>> = database.rawQuery(sql,args.map { it?.toString() }.toTypedArray()).use { cursor ->
        buildList { while(cursor.moveToNext()) add(cursor.getString(0) to cursor.getBlob(1)) }
    }
    override fun close() { statements.values.forEach { it.close() }; database.close() }
}
