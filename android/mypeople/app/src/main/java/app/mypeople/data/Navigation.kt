package app.mypeople.data

/** Contact indices, not LazyColumn header offsets. Also used by the accessible letter chooser. */
data class PeopleSection(val letter: Char, val firstIndex: Int, val count: Int)

fun peopleSections(names: List<String>): List<PeopleSection> {
    val sections = mutableListOf<PeopleSection>()
    names.forEachIndexed { index, name ->
        val letter = contactLetter(name)
        val previous = sections.lastOrNull()
        if (previous?.letter == letter) sections[sections.lastIndex] = previous.copy(count = previous.count + 1)
        else sections.add(PeopleSection(letter, index, 1))
    }
    return sections
}

/** Clamped coordinates keep a thumb dragged beyond either end on the first/last section. */
fun fastScrollSection(y: Float, height: Float, sectionCount: Int): Int? {
    if (sectionCount <= 0 || height <= 0f || !height.isFinite() || !y.isFinite()) return null
    return ((y / height).coerceIn(0f, 1f) * sectionCount).toInt().coerceIn(0, sectionCount - 1)
}

/** A single tap restores a tab. Two consecutive taps on the same tab request its top. */
class TabTapTracker(private val timeoutMillis: Long) {
    private var previousTab: String? = null
    private var previousTime: Long = 0

    fun tap(tab: String, uptimeMillis: Long): Boolean {
        val doubleTap = previousTab == tab && uptimeMillis - previousTime in 0..timeoutMillis
        previousTab = if (doubleTap) null else tab
        previousTime = uptimeMillis
        return doubleTap
    }
}
