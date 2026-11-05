package app.mypeople.ui

import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

// Avatar silhouettes from the Kin design system, as unit-square polygons (x, y pairs).
// Shape is meaning: circle = everyone, cookie = favorite, clover = group, soft square = business.
private val CookiePoints = floatArrayOf(
    0.96f, 0.5f, 0.935f, 0.53f, 0.918f, 0.559f, 0.913f, 0.588f, 0.92f, 0.62f, 0.932f, 0.657f, 0.942f, 0.697f, 0.94f,
    0.734f, 0.922f, 0.764f, 0.891f, 0.784f, 0.852f, 0.796f, 0.814f, 0.803f, 0.782f, 0.814f, 0.76f, 0.833f, 0.744f,
    0.862f, 0.73f, 0.898f, 0.712f, 0.935f, 0.687f, 0.962f, 0.654f, 0.974f, 0.617f, 0.969f, 0.58f, 0.953f, 0.546f,
    0.934f, 0.515f, 0.922f, 0.485f, 0.922f, 0.454f, 0.934f, 0.42f, 0.953f, 0.383f, 0.969f, 0.346f, 0.974f, 0.313f,
    0.962f, 0.288f, 0.935f, 0.27f, 0.898f, 0.256f, 0.862f, 0.24f, 0.833f, 0.218f, 0.814f, 0.186f, 0.803f, 0.148f,
    0.796f, 0.109f, 0.784f, 0.078f, 0.764f, 0.06f, 0.734f, 0.058f, 0.697f, 0.068f, 0.657f, 0.08f, 0.62f, 0.087f, 0.588f,
    0.082f, 0.559f, 0.065f, 0.53f, 0.04f, 0.5f, 0.018f, 0.466f, 0.007f, 0.431f, 0.013f, 0.396f, 0.035f, 0.367f, 0.068f,
    0.343f, 0.101f, 0.322f, 0.127f, 0.302f, 0.142f, 0.276f, 0.147f, 0.243f, 0.148f, 0.204f, 0.152f, 0.164f, 0.167f,
    0.13f, 0.193f, 0.108f, 0.23f, 0.099f, 0.27f, 0.102f, 0.309f, 0.108f, 0.342f, 0.109f, 0.37f, 0.099f, 0.394f, 0.076f,
    0.42f, 0.047f, 0.449f, 0.019f, 0.483f, 0.002f, 0.517f, 0.002f, 0.551f, 0.019f, 0.58f, 0.047f, 0.606f, 0.076f, 0.63f,
    0.099f, 0.658f, 0.109f, 0.691f, 0.108f, 0.73f, 0.102f, 0.77f, 0.099f, 0.807f, 0.108f, 0.833f, 0.13f, 0.848f, 0.164f,
    0.852f, 0.204f, 0.853f, 0.243f, 0.858f, 0.276f, 0.873f, 0.302f, 0.899f, 0.322f, 0.932f, 0.343f, 0.965f, 0.367f,
    0.987f, 0.396f, 0.993f, 0.431f, 0.982f, 0.466f,
)
private val CloverPoints = floatArrayOf(
    1f, 0.5f, 0.999f, 0.526f, 0.996f, 0.552f, 0.991f, 0.578f, 0.984f, 0.603f, 0.975f, 0.627f, 0.964f, 0.651f, 0.952f,
    0.673f, 0.937f, 0.695f, 0.921f, 0.715f, 0.904f, 0.733f, 0.884f, 0.75f, 0.864f, 0.764f, 0.841f, 0.776f, 0.816f,
    0.785f, 0.783f, 0.783f, 0.785f, 0.816f, 0.776f, 0.841f, 0.764f, 0.864f, 0.75f, 0.884f, 0.733f, 0.904f, 0.715f,
    0.921f, 0.695f, 0.937f, 0.673f, 0.952f, 0.651f, 0.964f, 0.627f, 0.975f, 0.603f, 0.984f, 0.578f, 0.991f, 0.552f,
    0.996f, 0.526f, 0.999f, 0.5f, 1f, 0.474f, 0.999f, 0.448f, 0.996f, 0.422f, 0.991f, 0.397f, 0.984f, 0.373f, 0.975f,
    0.349f, 0.964f, 0.327f, 0.952f, 0.305f, 0.937f, 0.285f, 0.921f, 0.267f, 0.904f, 0.25f, 0.884f, 0.236f, 0.864f,
    0.224f, 0.841f, 0.215f, 0.816f, 0.217f, 0.783f, 0.184f, 0.785f, 0.159f, 0.776f, 0.136f, 0.764f, 0.116f, 0.75f,
    0.096f, 0.733f, 0.079f, 0.715f, 0.063f, 0.695f, 0.048f, 0.673f, 0.036f, 0.651f, 0.025f, 0.627f, 0.016f, 0.603f,
    0.009f, 0.578f, 0.004f, 0.552f, 0.001f, 0.526f, 0f, 0.5f, 0.001f, 0.474f, 0.004f, 0.448f, 0.009f, 0.422f, 0.016f,
    0.397f, 0.025f, 0.373f, 0.036f, 0.349f, 0.048f, 0.327f, 0.063f, 0.305f, 0.079f, 0.285f, 0.096f, 0.267f, 0.116f,
    0.25f, 0.136f, 0.236f, 0.159f, 0.224f, 0.184f, 0.215f, 0.217f, 0.217f, 0.215f, 0.184f, 0.224f, 0.159f, 0.236f,
    0.136f, 0.25f, 0.116f, 0.267f, 0.096f, 0.285f, 0.079f, 0.305f, 0.063f, 0.327f, 0.048f, 0.349f, 0.036f, 0.373f,
    0.025f, 0.397f, 0.016f, 0.422f, 0.009f, 0.448f, 0.004f, 0.474f, 0.001f, 0.5f, 0f, 0.526f, 0.001f, 0.552f, 0.004f,
    0.578f, 0.009f, 0.603f, 0.016f, 0.627f, 0.025f, 0.651f, 0.036f, 0.673f, 0.048f, 0.695f, 0.063f, 0.715f, 0.079f,
    0.733f, 0.096f, 0.75f, 0.116f, 0.764f, 0.136f, 0.776f, 0.159f, 0.785f, 0.184f, 0.783f, 0.217f, 0.816f, 0.215f,
    0.841f, 0.224f, 0.864f, 0.236f, 0.884f, 0.25f, 0.904f, 0.267f, 0.921f, 0.285f, 0.937f, 0.305f, 0.952f, 0.327f,
    0.964f, 0.349f, 0.975f, 0.373f, 0.984f, 0.397f, 0.991f, 0.422f, 0.996f, 0.448f, 0.999f, 0.474f,
)

/** A polygon that morphs from a circle (progress 0) to its own outline (progress 1). */
class MorphPolygonShape(private val points: FloatArray, private val progress: Float = 1f) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val path = Path()
        for (i in points.indices step 2) {
            val x = points[i]; val y = points[i + 1]
            val angle = atan2(y - .5f, x - .5f)
            val px = (.5f + .5f * cos(angle)) + (x - (.5f + .5f * cos(angle))) * progress
            val py = (.5f + .5f * sin(angle)) + (y - (.5f + .5f * sin(angle))) * progress
            if (i == 0) path.moveTo(px * size.width, py * size.height) else path.lineTo(px * size.width, py * size.height)
        }
        path.close()
        return Outline.Generic(path)
    }
    override fun equals(other: Any?) = other is MorphPolygonShape && other.points === points && other.progress == progress
    override fun hashCode() = 31 * points.hashCode() + progress.hashCode()
}

fun cookieShape(progress: Float = 1f): Shape = MorphPolygonShape(CookiePoints, progress)
val CloverShape: Shape = MorphPolygonShape(CloverPoints)
