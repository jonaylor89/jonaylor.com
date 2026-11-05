package app.mypeople.data

import org.junit.Assert.*
import org.junit.Test

class PhoneNumbersTest {
    @Test fun `local formats normalize using their own country without truncation`() {
        val cases = listOf(
            Triple("GB", "020 7946 0018", "+442079460018"),
            Triple("DE", "030 123456", "+4930123456"),
            Triple("FR", "01 42 68 53 00", "+33142685300"),
            Triple("JP", "03-1234-5678", "+81312345678"),
            Triple("IT", "06 6982", "+39066982"),
            Triple("AU", "02 9374 4000", "+61293744000"),
            Triple("IN", "080 2345 6789", "+918023456789"),
            Triple("BR", "011 2345-6789", "+551123456789"),
            Triple("US", "(415) 555-0123", "+14155550123"),
            Triple("CA", "416 555 0123", "+14165550123"),
            Triple("US", "011 44 20 7946 0018", "+442079460018"),
            Triple("DE", "00 44 20 7946 0018", "+442079460018"),
        )
        cases.forEach { (region, raw, expected) ->
            assertEquals("$raw / $region", expected, phoneSmsTarget(raw, region))
            assertEquals(expected, phoneCallTarget(raw, region))
        }
    }
    @Test fun `explicit country codes override the default country and keep Italian zero`() {
        listOf("US", "DE", "JP", "GB").forEach { region ->
            assertEquals("+39066982", dialable("+39 06 6982", region))
            assertEquals("+442079460018", dialable("+44 20 7946 0018", region))
            assertEquals("+80012345678", dialable("+800 12345678", region))
        }
        assertNotEquals(dialable("+44 20 7946 0018", "US"), dialable("+49 20 7946 0018", "US"))
    }
    @Test fun `call targets wait for extensions and text targets never contain extensions`() {
        listOf("020 7946 0018 ext 0042", "tel:+442079460018;ext=0042", "+442079460018;0042", "+442079460018,0042").forEach { raw ->
            assertEquals("+442079460018;ext=0042", dialable(raw, "GB"))
            assertEquals("+442079460018;0042", phoneCallTarget(raw, "GB"))
            assertEquals("+442079460018", phoneSmsTarget(raw, "GB"))
        }
    }
    @Test fun `portable vcard TEL values are international but original strings still roundtrip`() {
        val card = ContactCard("International", region = "GB", fields = listOf(
            ContactField("phone", "020 7946 0018 ext 42", "Office"),
            ContactField("phone", "03-1234-5678", "Japan", region = "JP"),
        ))
        val text = VCards.export(listOf(card))
        assertTrue(text.contains("item0.TEL:+442079460018\\;ext=42"))
        assertTrue(text.contains("item1.TEL;X-SHERLOQ-REGION=JP:+81312345678"))
        assertTrue(text.contains("X-SHERLOQ-ORIGINAL-PHONE:020 7946 0018 ext 42"))
        val restored = VCards.parse(text).single()
        assertEquals(card.region, restored.region); assertEquals(card.fields, restored.fields)
    }
    @Test fun `a mismatched original metadata value cannot replace the exported number`() {
        val card = VCards.parse("BEGIN:VCARD\nFN:Example\nitem1.TEL:+442079460018\nitem1.X-SHERLOQ-ORIGINAL-PHONE:+4930123456\nEND:VCARD\n").single()
        assertEquals("+442079460018", card.fields.single().value)
    }
    @Test fun `merging countries retains each original and the correct dialing country`() {
        val a = ContactCard("First", region = "GB", fields = listOf(ContactField("phone", "020 7946 0018")))
        val b = ContactCard("Second", region = "JP", fields = listOf(ContactField("phone", "03-1234-5678"), ContactField("phone", "030 123456", region = "DE")))
        val merged = mergeCards(a, b)
        assertEquals(listOf("020 7946 0018", "03-1234-5678", "030 123456"), merged.fields.map { it.value })
        assertEquals(listOf("+442079460018", "+81312345678", "+4930123456"), merged.fields.map { phoneSmsTarget(it.value, it.region.ifEmpty { merged.region }) })
    }
    @Test fun `international search finds a national number using its full country code`() {
        val records = Records(people = mapOf(1 to Person("German", card = ContactCard("German", region = "DE", fields = listOf(ContactField("phone", "030 123456"))))))
        assertEquals(1, records.search("+49 30 123456").single().key)
        assertEquals(1, records.search("030 123456").single().key)
        assertTrue(records.search("+44 30 123456").isEmpty())
    }
    @Test fun `legacy matching keys are never exported with an invented US country code`() {
        val field = ContactField("phone", "2079460018")
        val legacy = ContactCard("Legacy", legacy_unverified = true, fields = listOf(field))
        assertFalse(legacy.canNormalizePhone(field))
        val exported = VCards.export(listOf(legacy))
        assertTrue(exported.contains("item0.TEL:2079460018"))
        assertFalse(exported.contains("+12079460018"))
        assertTrue(VCards.parse(exported).single().legacy_unverified)
        assertTrue(legacy.canNormalizePhone(field.copy(value = "+442079460018")))
    }
    @Test fun `recovering original contacts replaces legacy phone hints instead of keeping wrong dial targets`() {
        val legacy = ContactCard("Legacy", legacy_unverified = true, fields = listOf(ContactField("phone", "2079460018")))
        val original = ContactCard("Original", region = "GB", fields = listOf(ContactField("phone", "+442079460018", "Work")))
        val recovered = app.mypeople.ui.fillContact(legacy, original)
        assertFalse(recovered.legacy_unverified)
        assertEquals(listOf("+442079460018"), recovered.fields.map { it.value })
        assertTrue(app.mypeople.ui.fillContact(legacy, ContactCard("Email only", fields = listOf(ContactField("email", "test@example.org")))).legacy_unverified)
    }
    @Test fun `country metadata is accepted only for real supported regions`() {
        assertEquals("GB", phoneRegion("+442079460018")); assertEquals("DE", phoneRegion("+4930123456"))
        assertNull(phoneRegion("030 123456")); assertNull(phoneRegion("+80012345678"))
        for (card in listOf(ContactCard("A", region = "ZZ"), ContactCard("B", fields = listOf(ContactField("phone", "123", region = "ZZ"))))) {
            try { card.validate(); fail("Unsupported region") } catch (_: IllegalArgumentException) { }
        }
        assertNull(internationalPhone("not a number", "US"))
        assertNull(internationalPhone("+441234567890123456789", "GB"))
    }
}
