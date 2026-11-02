package com.parlo.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.CornerRounding
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.RoundedPolygon
import androidx.graphics.shapes.circle
import androidx.graphics.shapes.star
import androidx.graphics.shapes.toPath
import com.parlo.app.model.AudioState
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LiveSessionState
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloMotion
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.theme.rememberReducedMotion

/** What Parlo is doing, told apart by silhouette first and colour second. */
enum class OrbState { LISTENING, SPEAKING, THINKING, MUTED, RECONNECTING }

fun LiveSessionState.orbState(): OrbState = when {
    connection == ConnectionState.CONNECTING || connection == ConnectionState.RECONNECTING || audio == AudioState.RECONNECTING -> OrbState.RECONNECTING
    connection == ConnectionState.ENDING -> OrbState.THINKING
    audio == AudioState.SPEAKING -> OrbState.SPEAKING
    muted || audio == AudioState.MUTED -> OrbState.MUTED
    else -> OrbState.LISTENING
}

private object OrbShapes {
    val circle = RoundedPolygon.circle(numVertices = 12).normalized()
    /** 9-point scallop for the tutor's voice. */
    val scallop = RoundedPolygon.star(
        numVerticesPerRadius = 9, innerRadius = 0.84f,
        rounding = CornerRounding(0.32f), innerRounding = CornerRounding(0.32f),
    ).normalized()
    /** 4-leaf clover while Parlo thinks. */
    val clover = RoundedPolygon.star(
        numVerticesPerRadius = 4, innerRadius = 0.46f,
        rounding = CornerRounding(0.62f), innerRounding = CornerRounding(0.2f),
    ).normalized()

    fun of(state: OrbState) = when (state) {
        OrbState.SPEAKING -> scallop
        OrbState.THINKING -> clover
        else -> circle
    }
}

/**
 * The heart of the walk screen. Listening breathes as a circle, speaking is a scallop, thinking a slowly
 * turning clover, muted an outline with `mic_off`, reconnecting a dashed ring. Shapes morph with the
 * spatial spring; with reduced motion they swap in a short tween and stop breathing and turning.
 */
@Composable
fun VoiceOrb(state: OrbState, modifier: Modifier = Modifier, size: Dp = ParloSize.orb) {
    val colors = Parlo.colors
    val reduced = rememberReducedMotion()
    val target = when (state) {
        OrbState.LISTENING -> colors.stateListening
        OrbState.SPEAKING -> colors.stateSpeaking
        OrbState.THINKING -> colors.stateThinking
        OrbState.MUTED -> colors.stateMuted
        OrbState.RECONNECTING -> colors.stateReconnecting
    }
    val color by animateColorAsState(target, if (reduced) ParloMotion.reducedMotion() else ParloMotion.effects(), label = "orb-color")
    val outlined = state == OrbState.MUTED || state == OrbState.RECONNECTING
    val fill by animateFloatAsState(if (outlined) 0f else 1f, if (reduced) ParloMotion.reducedMotion() else ParloMotion.effects(), label = "orb-fill")

    var from by remember { mutableStateOf(OrbShapes.of(state)) }
    var to by remember { mutableStateOf(OrbShapes.of(state)) }
    val progress = remember { Animatable(1f) }
    LaunchedEffect(state) {
        val next = OrbShapes.of(state)
        if (next === to) return@LaunchedEffect
        from = to
        to = next
        progress.snapTo(0f)
        progress.animateTo(1f, if (reduced) ParloMotion.reducedMotion() else ParloMotion.spatial())
    }
    val morph = remember(from, to) { Morph(from, to) }

    val loop = rememberInfiniteTransition(label = "orb-loop")
    val breath by loop.animateFloat(
        1f, 1.04f, infiniteRepeatable(tween(ParloMotion.DURATION_BREATH / 2, easing = ParloMotion.Emphasized), RepeatMode.Reverse), label = "breath",
    )
    val turn by loop.animateFloat(0f, 360f, infiniteRepeatable(tween(6_000, easing = LinearEasing)), label = "turn")
    val pulse by loop.animateFloat(
        1f, 1.03f, infiniteRepeatable(tween(520, easing = ParloMotion.Emphasized), RepeatMode.Reverse), label = "pulse",
    )
    val androidPath = remember { android.graphics.Path() }

    Box(modifier.size(size).testTag("state_orb"), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            val s = when {
                reduced -> 1f
                state == OrbState.LISTENING -> breath
                state == OrbState.SPEAKING -> pulse
                else -> 1f
            }
            val angle = when {
                reduced -> 0f
                state == OrbState.THINKING -> turn
                state == OrbState.SPEAKING -> turn / 4f
                else -> 0f
            }
            val stroke = 4.dp.toPx()
            val inset = stroke
            val side = this.size.minDimension - inset * 2
            androidPath.rewind()
            morph.toPath(progress.value.coerceIn(0f, 1.08f), androidPath)
            val path = androidPath.asComposePath().apply {
                transform(Matrix().apply { translate(inset, inset); scale(side, side) })
            }
            scale(s) {
                rotate(angle) {
                    if (fill > 0f) drawPath(path, color.copy(alpha = color.alpha * fill))
                    if (fill < 1f) {
                        drawPath(
                            path, color.copy(alpha = color.alpha * (1f - fill)),
                            style = Stroke(
                                width = stroke, cap = StrokeCap.Round,
                                pathEffect = if (state == OrbState.RECONNECTING) PathEffect.dashPathEffect(floatArrayOf(18.dp.toPx(), 12.dp.toPx())) else null,
                            ),
                        )
                    }
                }
            }
        }
        if (state == OrbState.MUTED) {
            Icon(Icons.Rounded.MicOff, contentDescription = null, tint = color, modifier = Modifier.size(size * 0.28f))
        }
    }
}
