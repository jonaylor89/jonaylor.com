package app.mypeople

import android.os.Build
import androidx.annotation.RequiresApi
import androidx.appfunctions.AppFunctionDeclaration
import androidx.appfunctions.AppFunctionElementNotFoundException
import androidx.appfunctions.AppFunctionInvalidArgumentException
import androidx.appfunctions.AppFunctionService
import androidx.appfunctions.AppFunctionServiceEntryPoint
import app.mypeople.data.*
import java.time.LocalDate

/**
 * Read-only questions an assistant (such as Gemini) may ask MyPeople. Android lets only
 * assistants holding EXECUTE_APP_FUNCTIONS call them. Nothing here edits your memory.
 */
@RequiresApi(Build.VERSION_CODES.BAKLAVA)
@AppFunctionServiceEntryPoint(serviceName = "MyPeopleFunctionService", appFunctionXmlFileName = "mypeople_functions")
abstract class AssistantFunctions : AppFunctionService() {
    private suspend fun records(): Records {
        val graph = (application as MyPeopleApp).graph
        graph.store.initialize()
        return graph.store.state.value.records
    }
    private fun <T> answer(block: () -> T): T = try { block() } catch (e: IllegalArgumentException) { throw AppFunctionInvalidArgumentException(e.message) }

    /**
     * Finds people in the user's MyPeople memory by name, nickname, phone number, or email.
     * Use it first to turn a name like "Rob" into a personId. Closest relationships come first.
     *
     * @param query A name, nickname, phone number, or email address.
     * @param limit The most people to return, from 1 to 20.
     * @return The people who matched, closest first. Empty if nobody matched.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun findPerson(query: String, limit: Int): List<PersonMatch> = records().let { r -> answer { r.assistantFindPeople(query, limit) } }

    /**
     * Summarizes what MyPeople remembers about one person: how you're related, when you last
     * talked, where they live and work now, and recent life events and notes.
     *
     * @param personId The personId from findPerson.
     * @return The person's summary.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun getPersonSummary(personId: Int): PersonSummary =
        records().assistantSummary(personId, LocalDate.now()) ?: throw AppFunctionElementNotFoundException("No person with id $personId. Use findPerson to look them up.")

    /**
     * Lists the people MyPeople suggests reaching out to now, and why: birthdays, anniversaries,
     * news worth congratulating, or someone it's been a while since. Covers the last week.
     *
     * @return Suggestions, today's first. Empty on a quiet day.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun getTodaysMoments(): List<SuggestedMoment> = records().assistantMoments(LocalDate.now())

    /**
     * Finds people who live in a place, from their contact-card addresses and the latest move
     * they told the user about. Useful when the user is traveling: "who do I know in Austin?"
     *
     * @param place A city, region, or country, such as "Austin" or "Portugal".
     * @return People connected to that place, closest first.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun listPeopleInPlace(place: String): List<PlaceMatch> = records().let { r -> answer { r.assistantPeopleIn(place) } }

    /**
     * Lists people the user is losing touch with: contact is fading, or it's been well past how
     * often the user wanted to be in touch. Muted people are left out.
     *
     * @param limit The most people to return, from 1 to 50.
     * @return People to reconnect with, closest relationships first.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun listDrifting(limit: Int): List<DriftingPerson> = records().assistantDrifting(LocalDate.now(), limit)

    /**
     * Lists birthdays, anniversaries, and the plans and trips people mentioned, coming up soon.
     * Muted people are left out.
     *
     * @param days How many days ahead to look, from 1 to 60.
     * @return Upcoming dates, soonest first.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    suspend fun upcomingDates(days: Int): List<UpcomingDate> = records().assistantUpcoming(LocalDate.now(), days)
}
