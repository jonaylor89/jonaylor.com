package app.mypeople.data

import org.junit.Assert.*
import org.junit.Test

class NavigationTest {
    @Test fun `section targets are exact contact indices including accents and numbers`() {
        val sections = peopleSections(listOf("Alice", "Åsa", "Bob", "Zoe", "+441234567890", "@handle"))
        assertEquals(listOf(PeopleSection('A', 0, 2), PeopleSection('B', 2, 1), PeopleSection('Z', 3, 1), PeopleSection('#', 4, 2)), sections)
        assertTrue(peopleSections(emptyList()).isEmpty())
        assertEquals(listOf(PeopleSection('#', 0, 2)), peopleSections(listOf("123", "456")))
    }
    @Test fun `large address books jump directly without header offsets`() {
        val names = ('A'..'Z').flatMap { letter -> (0 until 1000).map { "$letter Person $it" } } + List(2000) { "+1 555 $it" }
        val sections = peopleSections(names)
        assertEquals(27, sections.size)
        assertEquals(PeopleSection('Z', 25000, 1000), sections[25])
        assertEquals(PeopleSection('#', 26000, 2000), sections.last())
    }
    @Test fun `fast scroll clamps to available sections and handles invalid geometry`() {
        assertEquals(0, fastScrollSection(-100f, 540f, 27))
        assertEquals(0, fastScrollSection(0f, 540f, 27))
        assertEquals(13, fastScrollSection(270f, 540f, 27))
        assertEquals(26, fastScrollSection(540f, 540f, 27))
        assertEquals(26, fastScrollSection(900f, 540f, 27))
        assertEquals(0, fastScrollSection(5f, 10f, 1))
        assertNull(fastScrollSection(0f, 0f, 27)); assertNull(fastScrollSection(1f, 2f, 0))
        assertNull(fastScrollSection(Float.NaN, 100f, 27)); assertNull(fastScrollSection(1f, Float.POSITIVE_INFINITY, 27))
    }
    @Test fun `double taps reset every root but single and slow taps restore position`() {
        for (tab in listOf("home", "people", "review", "settings")) {
            val taps = TabTapTracker(300)
            assertFalse(taps.tap(tab, 1000)); assertTrue(taps.tap(tab, 1200))
            assertFalse(taps.tap(tab, 1300)) // triple tap is not a second double tap
            assertFalse(taps.tap(tab, 1700)); assertTrue(taps.tap(tab, 2000))
        }
    }
    @Test fun `different tabs and a reversed clock do not count as double taps`() {
        val taps = TabTapTracker(300)
        assertFalse(taps.tap("home", 1000)); assertFalse(taps.tap("people", 1100))
        assertFalse(taps.tap("home", 1200)); assertFalse(taps.tap("home", 100))
        assertTrue(taps.tap("home", 200))
    }
}
