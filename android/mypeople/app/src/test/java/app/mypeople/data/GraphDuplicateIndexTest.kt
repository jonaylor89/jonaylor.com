package app.mypeople.data

import kotlin.random.Random
import org.junit.Assert.*
import org.junit.Test

class GraphDuplicateIndexTest {
    @Test fun `incremental candidates match the compatibility reducer across edits and thresholds`() {
        val random = Random(416)
        val names = listOf("Cam", "Cam Smith", "Cam Jones", "Cam Wu", "Cam Lee", "Cam Long", "Adá", "Ada", "ADA", "Ada Smith", "Ada  Smith", "Ada\tSmith", "a@example.test", "+12025550101", "Other", "Other Smith")
        var people = emptyMap<Int, Person>()
        var index = GraphDuplicateIndex()
        repeat(500) {
            val id = random.nextInt(25)
            val fields = listOf(
                ContactField("phone", "+1 (202) 555-010${random.nextInt(5)}"),
                ContactField("email", " Person${random.nextInt(5)}@example.test "),
            )
            people = if (random.nextInt(10) == 0) people - id else people + (id to Person(
                names.random(random), contact_uid = "synthetic-$id",
                card = ContactCard(names.random(random), fields = fields), trashed = random.nextInt(10) == 0,
            ))
            index = index.updated(people, setOf(id))
            val distinct = listOf(setOf(2, 3, 4), setOf(7, 8, 9, 10))
            val reference = localDuplicates(Records(people = people), people.values.map { p -> p.contact_uid }.toSet(), distinct)
            assertEquals("Candidate mismatch at edit $it", reference, index.groups(distinct))
            val unchanged = people.mapValues { (_, p) -> p.copy(card = p.contactCard().copy(favorite = true)) }
            assertSame(index, index.updated(unchanged, people.keys))
        }
    }
}
