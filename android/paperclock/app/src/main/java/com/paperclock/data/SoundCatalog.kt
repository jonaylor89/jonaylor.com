package com.paperclock.data

import com.paperclock.R

data class AlarmSound(val key: String, val displayName: String, val resourceId: Int)

/** Maps bundled raw resource IDs to their human-readable sound names. */
object SoundCatalog {
    val sounds = listOf(
        AlarmSound("beep_beep_beep", "Beep Beep Beep", R.raw.beep_beep_beep),
        AlarmSound("good_morning_sunshine", "Good Morning Sunshine", R.raw.good_morning_sunshine),
        AlarmSound("harp_smash", "Harp Smash", R.raw.harp_smash),
        AlarmSound("iron_paradise", "Iron Paradise", R.raw.iron_paradise),
        AlarmSound("lovely_flute_wakey_wakey", "Lovely Flute (Wakey Wakey)", R.raw.lovely_flute_wakey_wakey),
        AlarmSound("old_school", "Old School", R.raw.old_school),
        AlarmSound("ring_ring", "Ring Ring", R.raw.ring_ring),
        AlarmSound("the_roar", "The Roar", R.raw.the_roar)
    )
    fun byKey(key: String) = sounds.firstOrNull { it.key == key } ?: sounds.first()
}
