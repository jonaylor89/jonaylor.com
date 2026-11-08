package app.mypeople.data

import com.google.i18n.phonenumbers.PhoneNumberUtil
import java.util.Locale

private val postDialExtension = Regex("[;,]\\s*([0-9]+)\\s*$")

/** Original strings stay on the card; only action/export targets are normalized. */
data class InternationalPhone(val number: String, val extension: String = "") {
    val rfc3966: String get() = number + if (extension.isEmpty()) "" else ";ext=$extension"
    // Android's dialer uses ';' for wait/post-dial digits, not the literal letters 'ext='.
    val callTarget: String get() = number + if (extension.isEmpty()) "" else ";$extension"
    val smsTarget: String get() = number
}

fun internationalPhone(raw: String, region: String): InternationalPhone? = runCatching {
    val util = PhoneNumberUtil.getInstance()
    val input = raw.trim().let { value -> postDialExtension.replace(value) { ";ext=${it.groupValues[1]}" } }
    val parsed = util.parse(input, region.trim().uppercase(Locale.ROOT))
    if (!util.isPossibleNumber(parsed)) return@runCatching null
    val number = util.format(parsed, PhoneNumberUtil.PhoneNumberFormat.E164)
    if (number.removePrefix("+").length > 15) null
    else InternationalPhone(number, if (parsed.hasExtension()) parsed.extension else "")
}.getOrNull()

/** Format only explicit international numbers; never make an unknown local number look US. */
internal fun phoneDisplay(raw: String): String = if (!hasInternationalPrefix(raw)) raw else runCatching {
    val util=PhoneNumberUtil.getInstance()
    util.format(util.parse(raw,"ZZ"),PhoneNumberUtil.PhoneNumberFormat.INTERNATIONAL)
}.getOrDefault(raw)

fun hasInternationalPrefix(raw: String): Boolean = raw.trim().startsWith("+") || raw.trim().startsWith("tel:+", ignoreCase = true)

fun dialable(raw: String, region: String): String? = internationalPhone(raw, region)?.rfc3966
fun phoneCallTarget(raw: String, region: String): String? = internationalPhone(raw, region)?.callTarget
fun phoneSmsTarget(raw: String, region: String): String? = internationalPhone(raw, region)?.smsTarget

/** Only derive a country from an explicitly international source, never a guessed suffix. */
fun phoneRegion(international: String): String? = runCatching {
    if (!international.trim().startsWith('+')) return@runCatching null
    val util = PhoneNumberUtil.getInstance()
    util.getRegionCodeForNumber(util.parse(international, "ZZ"))?.takeIf { it in util.supportedRegions }
}.getOrNull()
