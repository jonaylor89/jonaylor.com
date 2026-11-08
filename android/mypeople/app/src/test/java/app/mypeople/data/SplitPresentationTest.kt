package app.mypeople.data

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SplitPresentationTest {
    private fun point(kind: String, value: String) = splitPresentation("ContactPoint", buildJsonObject { put("kind", kind); put("value", value) })!!

    @Test fun `opaque Telegram keys are explained and never treated as public handles`() {
        val imported = point("telegram-contact", "123:abcdef")
        assertEquals("Telegram imported contact", imported.label)
        assertTrue(imported.detail.contains("not a Telegram username"))
        assertTrue(imported.detail.contains("123:abcdef"))
        assertNull(imported.url)
        assertNull(point("telegram", "123456").url)
        assertEquals("https://t.me/cameron", point("telegram", "@cameron").url)
    }

    @Test fun `social handles and account IDs have platform appropriate destinations`() {
        assertEquals("https://www.instagram.com/cameron/", point("instagram", "@cameron").url)
        assertEquals("https://www.linkedin.com/in/cameron/", point("linkedin", "cameron").url)
        assertEquals("https://www.snapchat.com/add/cameron", point("snapchat", "cameron").url)
        assertEquals("https://x.com/i/user/123456", point("x", "123456").url)
        assertEquals("https://x.com/cameron", point("x", "@cameron").url)
        assertNull(point("instagram", "not a handle").url)
        assertNull(point("website", "javascript:alert(1)").url)
        assertNull(point("website", "https://user:password@example.test").url)
    }

    @Test fun `Google details come only from the exact resource not another merged contact`() {
        val properties = buildJsonObject { put("kind", "google"); put("value", "people/c123") }
        val records = listOf(
            """{"resourceName":"people/c456","names":[{"displayName":"Other person"}]}""",
            """{"resourceName":"people/c123","names":[{"displayName":"Cameron"}],"phoneNumbers":[{"value":"+12025550101"}],"emailAddresses":[{"value":"cam@example.test"}],"organizations":[{"name":"Example Co"}]}""",
            "not JSON",
        )
        val result = splitPresentation("ContactPoint", properties, records)!!
        assertEquals("Google contact", result.label)
        assertEquals("https://contacts.google.com/person/c123", result.url)
        assertTrue(result.detail.contains("Cameron"))
        assertTrue(result.detail.contains("+12025550101"))
        assertTrue(result.detail.contains("cam@example.test"))
        assertTrue(result.detail.contains("Example Co"))
        assertFalse(result.detail.contains("Other person"))
    }

    @Test fun `profile claims show review context and expose only safe web links`() {
        val properties = buildJsonObject {
            put("predicate", "public_profile"); put("site", "LinkedIn"); put("value", "https://www.linkedin.com/in/cameron/")
            put("status", "suggested"); put("reason", "Imported profile URL")
        }
        val result = splitPresentation("Claim", properties)!!
        assertTrue(result.label.contains("LinkedIn"))
        assertTrue(result.detail.contains("suggested"))
        assertTrue(result.detail.contains("Imported profile URL"))
        assertEquals("https://www.linkedin.com/in/cameron/", result.url)
        assertNull(splitPresentation("Claim", JsonObject(properties + ("value" to JsonPrimitive("intent://unsafe"))))!!.url)
    }
}
