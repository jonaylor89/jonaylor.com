package com.parlo.app.uiaudit

import org.robolectric.RobolectricTestRunner
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStore
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.SecureRandom
import java.security.Security
import java.security.cert.Certificate
import java.security.spec.AlgorithmParameterSpec
import java.util.Collections
import java.util.Date
import java.util.Enumeration
import javax.crypto.KeyGenerator
import javax.crypto.KeyGeneratorSpi
import javax.crypto.SecretKey

/** Robolectric has no AndroidKeyStore; EncryptedSharedPreferences needs one. In-memory stand-in for audit runs only. */
class KeystoreRunner(c: Class<*>) : RobolectricTestRunner(c) {
    companion object {
        init {
            if (Security.getProvider("AndroidKeyStore") == null) Security.addProvider(FakeAndroidKeyStore())
        }
    }
}

internal object FakeKeys { val map = Collections.synchronizedMap(mutableMapOf<String, Key>()) }

class FakeAndroidKeyStore : Provider("AndroidKeyStore", 1.0, "fake") {
    init {
        put("KeyStore.AndroidKeyStore", FakeKeyStoreSpi::class.java.name)
        put("KeyGenerator.AES", FakeAesKeyGen::class.java.name)
    }
}

class FakeKeyStoreSpi : KeyStoreSpi() {
    override fun engineGetKey(alias: String, password: CharArray?): Key? = FakeKeys.map[alias]
    override fun engineGetCertificateChain(alias: String?): Array<Certificate>? = null
    override fun engineGetCertificate(alias: String?): Certificate? = null
    override fun engineGetCreationDate(alias: String?): Date = Date()
    override fun engineSetKeyEntry(alias: String, key: Key, password: CharArray?, chain: Array<out Certificate>?) { FakeKeys.map[alias] = key }
    override fun engineSetKeyEntry(alias: String?, key: ByteArray?, chain: Array<out Certificate>?) = throw UnsupportedOperationException()
    override fun engineSetCertificateEntry(alias: String?, cert: Certificate?) = throw UnsupportedOperationException()
    override fun engineDeleteEntry(alias: String) { FakeKeys.map.remove(alias) }
    override fun engineAliases(): Enumeration<String> = Collections.enumeration(FakeKeys.map.keys.toList())
    override fun engineContainsAlias(alias: String): Boolean = FakeKeys.map.containsKey(alias)
    override fun engineSize(): Int = FakeKeys.map.size
    override fun engineIsKeyEntry(alias: String): Boolean = FakeKeys.map.containsKey(alias)
    override fun engineIsCertificateEntry(alias: String?): Boolean = false
    override fun engineGetCertificateAlias(cert: Certificate?): String? = null
    override fun engineStore(stream: OutputStream?, password: CharArray?) = Unit
    override fun engineLoad(stream: InputStream?, password: CharArray?) = Unit
    override fun engineLoad(param: KeyStore.LoadStoreParameter?) = Unit
}

class FakeAesKeyGen : KeyGeneratorSpi() {
    private var alias: String? = null
    private var bits = 256
    override fun engineInit(random: SecureRandom?) = Unit
    override fun engineInit(params: AlgorithmParameterSpec, random: SecureRandom?) {
        alias = params.javaClass.getMethod("getKeystoreAlias").invoke(params) as String
        bits = (params.javaClass.getMethod("getKeySize").invoke(params) as Int).takeIf { it > 0 } ?: 256
    }
    override fun engineInit(keysize: Int, random: SecureRandom?) { bits = keysize }
    override fun engineGenerateKey(): SecretKey {
        val k = KeyGenerator.getInstance("AES", "SunJCE").apply { init(bits) }.generateKey()
        alias?.let { FakeKeys.map[it] = k }
        return k
    }
}
