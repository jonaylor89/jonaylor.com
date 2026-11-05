/*
 * Copyright 2025 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


// Selected Material icons, vendored from AndroidX 1.7.8 (package changed).
// Keep the APK small without shipping the full extended-icon library.
package app.mypeople.ui.icons

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.ui.graphics.PathFillType.Companion.EvenOdd
import androidx.compose.ui.graphics.vector.ImageVector
import kotlin.Deprecated

public val Icons.Outlined.People: ImageVector
    get() {
        if (_people != null) {
            return _people!!
        }
        _people = materialIcon(name = "Outlined.People") {
            materialPath {
                moveTo(9.0f, 13.75f)
                curveToRelative(-2.34f, 0.0f, -7.0f, 1.17f, -7.0f, 3.5f)
                lineTo(2.0f, 19.0f)
                horizontalLineToRelative(14.0f)
                verticalLineToRelative(-1.75f)
                curveToRelative(0.0f, -2.33f, -4.66f, -3.5f, -7.0f, -3.5f)
                close()
                moveTo(4.34f, 17.0f)
                curveToRelative(0.84f, -0.58f, 2.87f, -1.25f, 4.66f, -1.25f)
                reflectiveCurveToRelative(3.82f, 0.67f, 4.66f, 1.25f)
                lineTo(4.34f, 17.0f)
                close()
                moveTo(9.0f, 12.0f)
                curveToRelative(1.93f, 0.0f, 3.5f, -1.57f, 3.5f, -3.5f)
                reflectiveCurveTo(10.93f, 5.0f, 9.0f, 5.0f)
                reflectiveCurveTo(5.5f, 6.57f, 5.5f, 8.5f)
                reflectiveCurveTo(7.07f, 12.0f, 9.0f, 12.0f)
                close()
                moveTo(9.0f, 7.0f)
                curveToRelative(0.83f, 0.0f, 1.5f, 0.67f, 1.5f, 1.5f)
                reflectiveCurveTo(9.83f, 10.0f, 9.0f, 10.0f)
                reflectiveCurveToRelative(-1.5f, -0.67f, -1.5f, -1.5f)
                reflectiveCurveTo(8.17f, 7.0f, 9.0f, 7.0f)
                close()
                moveTo(16.04f, 13.81f)
                curveToRelative(1.16f, 0.84f, 1.96f, 1.96f, 1.96f, 3.44f)
                lineTo(18.0f, 19.0f)
                horizontalLineToRelative(4.0f)
                verticalLineToRelative(-1.75f)
                curveToRelative(0.0f, -2.02f, -3.5f, -3.17f, -5.96f, -3.44f)
                close()
                moveTo(15.0f, 12.0f)
                curveToRelative(1.93f, 0.0f, 3.5f, -1.57f, 3.5f, -3.5f)
                reflectiveCurveTo(16.93f, 5.0f, 15.0f, 5.0f)
                curveToRelative(-0.54f, 0.0f, -1.04f, 0.13f, -1.5f, 0.35f)
                curveToRelative(0.63f, 0.89f, 1.0f, 1.98f, 1.0f, 3.15f)
                reflectiveCurveToRelative(-0.37f, 2.26f, -1.0f, 3.15f)
                curveToRelative(0.46f, 0.22f, 0.96f, 0.35f, 1.5f, 0.35f)
                close()
            }
        }
        return _people!!
    }

private var _people: ImageVector? = null

public val Icons.Outlined.FactCheck: ImageVector
    get() {
        if (_factCheck != null) {
            return _factCheck!!
        }
        _factCheck = materialIcon(name = "Outlined.FactCheck") {
            materialPath(pathFillType = EvenOdd) {
                moveTo(20.0f, 3.0f)
                horizontalLineTo(4.0f)
                curveTo(2.9f, 3.0f, 2.0f, 3.9f, 2.0f, 5.0f)
                verticalLineToRelative(14.0f)
                curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
                horizontalLineToRelative(16.0f)
                curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
                verticalLineTo(5.0f)
                curveTo(22.0f, 3.9f, 21.1f, 3.0f, 20.0f, 3.0f)
                close()
                moveTo(20.0f, 19.0f)
                horizontalLineTo(4.0f)
                verticalLineTo(5.0f)
                horizontalLineToRelative(16.0f)
                verticalLineTo(19.0f)
                close()
            }
            materialPath(pathFillType = EvenOdd) {
                moveTo(19.41f, 10.42f)
                lineToRelative(-1.42f, -1.42f)
                lineToRelative(-3.17f, 3.17f)
                lineToRelative(-1.41f, -1.42f)
                lineToRelative(-1.41f, 1.41f)
                lineToRelative(2.82f, 2.84f)
                close()
            }
            materialPath(pathFillType = EvenOdd) {
                moveTo(5.0f, 7.0f)
                horizontalLineToRelative(5.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(-5.0f)
                close()
            }
            materialPath(pathFillType = EvenOdd) {
                moveTo(5.0f, 11.0f)
                horizontalLineToRelative(5.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(-5.0f)
                close()
            }
            materialPath(pathFillType = EvenOdd) {
                moveTo(5.0f, 15.0f)
                horizontalLineToRelative(5.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(-5.0f)
                close()
            }
        }
        return _factCheck!!
    }

private var _factCheck: ImageVector? = null

public val Icons.Outlined.Tune: ImageVector
    get() {
        if (_tune != null) {
            return _tune!!
        }
        _tune = materialIcon(name = "Outlined.Tune") {
            materialPath {
                moveTo(3.0f, 17.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(6.0f)
                verticalLineToRelative(-2.0f)
                lineTo(3.0f, 17.0f)
                close()
                moveTo(3.0f, 5.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(10.0f)
                lineTo(13.0f, 5.0f)
                lineTo(3.0f, 5.0f)
                close()
                moveTo(13.0f, 21.0f)
                verticalLineToRelative(-2.0f)
                horizontalLineToRelative(8.0f)
                verticalLineToRelative(-2.0f)
                horizontalLineToRelative(-8.0f)
                verticalLineToRelative(-2.0f)
                horizontalLineToRelative(-2.0f)
                verticalLineToRelative(6.0f)
                horizontalLineToRelative(2.0f)
                close()
                moveTo(7.0f, 9.0f)
                verticalLineToRelative(2.0f)
                lineTo(3.0f, 11.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(4.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(2.0f)
                lineTo(9.0f, 9.0f)
                lineTo(7.0f, 9.0f)
                close()
                moveTo(21.0f, 13.0f)
                verticalLineToRelative(-2.0f)
                lineTo(11.0f, 11.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(10.0f)
                close()
                moveTo(15.0f, 9.0f)
                horizontalLineToRelative(2.0f)
                lineTo(17.0f, 7.0f)
                horizontalLineToRelative(4.0f)
                lineTo(21.0f, 5.0f)
                horizontalLineToRelative(-4.0f)
                lineTo(17.0f, 3.0f)
                horizontalLineToRelative(-2.0f)
                verticalLineToRelative(6.0f)
                close()
            }
        }
        return _tune!!
    }

private var _tune: ImageVector? = null

public val Icons.Outlined.CloudOff: ImageVector
    get() {
        if (_cloudOff != null) {
            return _cloudOff!!
        }
        _cloudOff = materialIcon(name = "Outlined.CloudOff") {
            materialPath {
                moveTo(24.0f, 15.0f)
                curveToRelative(0.0f, -2.64f, -2.05f, -4.78f, -4.65f, -4.96f)
                curveTo(18.67f, 6.59f, 15.64f, 4.0f, 12.0f, 4.0f)
                curveToRelative(-1.33f, 0.0f, -2.57f, 0.36f, -3.65f, 0.97f)
                lineToRelative(1.49f, 1.49f)
                curveTo(10.51f, 6.17f, 11.23f, 6.0f, 12.0f, 6.0f)
                curveToRelative(3.04f, 0.0f, 5.5f, 2.46f, 5.5f, 5.5f)
                verticalLineToRelative(0.5f)
                horizontalLineTo(19.0f)
                curveToRelative(1.66f, 0.0f, 3.0f, 1.34f, 3.0f, 3.0f)
                curveToRelative(0.0f, 0.99f, -0.48f, 1.85f, -1.21f, 2.4f)
                lineToRelative(1.41f, 1.41f)
                curveToRelative(1.09f, -0.92f, 1.8f, -2.27f, 1.8f, -3.81f)
                close()
                moveTo(4.41f, 3.86f)
                lineTo(3.0f, 5.27f)
                lineToRelative(2.77f, 2.77f)
                horizontalLineToRelative(-0.42f)
                curveTo(2.34f, 8.36f, 0.0f, 10.91f, 0.0f, 14.0f)
                curveToRelative(0.0f, 3.31f, 2.69f, 6.0f, 6.0f, 6.0f)
                horizontalLineToRelative(11.73f)
                lineToRelative(2.0f, 2.0f)
                lineToRelative(1.41f, -1.41f)
                lineTo(4.41f, 3.86f)
                close()
                moveTo(6.0f, 18.0f)
                curveToRelative(-2.21f, 0.0f, -4.0f, -1.79f, -4.0f, -4.0f)
                reflectiveCurveToRelative(1.79f, -4.0f, 4.0f, -4.0f)
                horizontalLineToRelative(1.73f)
                lineToRelative(8.0f, 8.0f)
                horizontalLineTo(6.0f)
                close()
            }
        }
        return _cloudOff!!
    }

private var _cloudOff: ImageVector? = null

public val Icons.Outlined.Schedule: ImageVector
    get() {
        if (_schedule != null) {
            return _schedule!!
        }
        _schedule = materialIcon(name = "Outlined.Schedule") {
            materialPath {
                moveTo(11.99f, 2.0f)
                curveTo(6.47f, 2.0f, 2.0f, 6.48f, 2.0f, 12.0f)
                reflectiveCurveToRelative(4.47f, 10.0f, 9.99f, 10.0f)
                curveTo(17.52f, 22.0f, 22.0f, 17.52f, 22.0f, 12.0f)
                reflectiveCurveTo(17.52f, 2.0f, 11.99f, 2.0f)
                close()
                moveTo(12.0f, 20.0f)
                curveToRelative(-4.42f, 0.0f, -8.0f, -3.58f, -8.0f, -8.0f)
                reflectiveCurveToRelative(3.58f, -8.0f, 8.0f, -8.0f)
                reflectiveCurveToRelative(8.0f, 3.58f, 8.0f, 8.0f)
                reflectiveCurveToRelative(-3.58f, 8.0f, -8.0f, 8.0f)
                close()
                moveTo(12.5f, 7.0f)
                lineTo(11.0f, 7.0f)
                verticalLineToRelative(6.0f)
                lineToRelative(5.25f, 3.15f)
                lineToRelative(0.75f, -1.23f)
                lineToRelative(-4.5f, -2.67f)
                close()
            }
        }
        return _schedule!!
    }

private var _schedule: ImageVector? = null

public val Icons.Outlined.Spa: ImageVector
    get() {
        if (_spa != null) {
            return _spa!!
        }
        _spa = materialIcon(name = "Outlined.Spa") {
            materialPath {
                moveTo(15.49f, 9.63f)
                curveToRelative(-0.18f, -2.79f, -1.31f, -5.51f, -3.43f, -7.63f)
                curveToRelative(-2.14f, 2.14f, -3.32f, 4.86f, -3.55f, 7.63f)
                curveToRelative(1.28f, 0.68f, 2.46f, 1.56f, 3.49f, 2.63f)
                curveToRelative(1.03f, -1.06f, 2.21f, -1.94f, 3.49f, -2.63f)
                close()
                moveTo(12.05f, 5.19f)
                curveToRelative(0.63f, 1.03f, 1.07f, 2.18f, 1.3f, 3.38f)
                curveToRelative(-0.47f, 0.3f, -0.91f, 0.63f, -1.34f, 0.98f)
                curveToRelative(-0.42f, -0.34f, -0.87f, -0.67f, -1.33f, -0.97f)
                curveToRelative(0.25f, -1.2f, 0.71f, -2.35f, 1.37f, -3.39f)
                close()
                moveTo(12.0f, 15.45f)
                curveToRelative(-0.82f, -1.25f, -1.86f, -2.34f, -3.06f, -3.2f)
                curveToRelative(-0.13f, -0.09f, -0.27f, -0.16f, -0.4f, -0.26f)
                curveToRelative(0.13f, 0.09f, 0.27f, 0.17f, 0.39f, 0.25f)
                curveTo(6.98f, 10.83f, 4.59f, 10.0f, 2.0f, 10.0f)
                curveToRelative(0.0f, 5.32f, 3.36f, 9.82f, 8.03f, 11.49f)
                curveToRelative(0.63f, 0.23f, 1.29f, 0.4f, 1.97f, 0.51f)
                curveToRelative(0.68f, -0.12f, 1.33f, -0.29f, 1.97f, -0.51f)
                curveTo(18.64f, 19.82f, 22.0f, 15.32f, 22.0f, 10.0f)
                curveToRelative(-4.18f, 0.0f, -7.85f, 2.17f, -10.0f, 5.45f)
                close()
                moveTo(13.32f, 19.6f)
                curveToRelative(-0.44f, 0.15f, -0.88f, 0.27f, -1.33f, 0.37f)
                curveToRelative(-0.44f, -0.09f, -0.87f, -0.21f, -1.28f, -0.36f)
                curveToRelative(-3.29f, -1.18f, -5.7f, -3.99f, -6.45f, -7.35f)
                curveToRelative(1.1f, 0.26f, 2.15f, 0.71f, 3.12f, 1.33f)
                lineToRelative(-0.02f, 0.01f)
                curveToRelative(0.13f, 0.09f, 0.26f, 0.18f, 0.39f, 0.25f)
                lineToRelative(0.07f, 0.04f)
                curveToRelative(0.99f, 0.72f, 1.84f, 1.61f, 2.51f, 2.65f)
                lineTo(12.0f, 19.1f)
                lineToRelative(1.67f, -2.55f)
                curveToRelative(0.69f, -1.05f, 1.55f, -1.95f, 2.53f, -2.66f)
                lineToRelative(0.07f, -0.05f)
                curveToRelative(0.09f, -0.05f, 0.18f, -0.11f, 0.27f, -0.17f)
                lineToRelative(-0.01f, -0.02f)
                curveToRelative(0.98f, -0.65f, 2.07f, -1.13f, 3.21f, -1.4f)
                curveToRelative(-0.75f, 3.37f, -3.15f, 6.18f, -6.42f, 7.35f)
                close()
                moveTo(8.99f, 12.28f)
                curveToRelative(-0.02f, -0.01f, -0.04f, -0.03f, -0.05f, -0.04f)
                curveToRelative(0.0f, 0.0f, 0.01f, 0.0f, 0.01f, 0.01f)
                curveToRelative(0.01f, 0.01f, 0.02f, 0.02f, 0.04f, 0.03f)
                close()
            }
        }
        return _spa!!
    }

private var _spa: ImageVector? = null

public val Icons.Outlined.ExpandMore: ImageVector
    get() {
        if (_expandMore != null) {
            return _expandMore!!
        }
        _expandMore = materialIcon(name = "Outlined.ExpandMore") {
            materialPath {
                moveTo(16.59f, 8.59f)
                lineTo(12.0f, 13.17f)
                lineTo(7.41f, 8.59f)
                lineTo(6.0f, 10.0f)
                lineToRelative(6.0f, 6.0f)
                lineToRelative(6.0f, -6.0f)
                lineToRelative(-1.41f, -1.41f)
                close()
            }
        }
        return _expandMore!!
    }

private var _expandMore: ImageVector? = null

public val Icons.Outlined.EditNote: ImageVector
    get() {
        if (_editNote != null) {
            return _editNote!!
        }
        _editNote = materialIcon(name = "Outlined.EditNote") {
            materialPath {
                moveTo(3.0f, 10.0f)
                horizontalLineToRelative(11.0f)
                verticalLineToRelative(2.0f)
                horizontalLineTo(3.0f)
                verticalLineTo(10.0f)
                close()
                moveTo(3.0f, 8.0f)
                horizontalLineToRelative(11.0f)
                verticalLineTo(6.0f)
                horizontalLineTo(3.0f)
                verticalLineTo(8.0f)
                close()
                moveTo(3.0f, 16.0f)
                horizontalLineToRelative(7.0f)
                verticalLineToRelative(-2.0f)
                horizontalLineTo(3.0f)
                verticalLineTo(16.0f)
                close()
                moveTo(18.01f, 12.87f)
                lineToRelative(0.71f, -0.71f)
                curveToRelative(0.39f, -0.39f, 1.02f, -0.39f, 1.41f, 0.0f)
                lineToRelative(0.71f, 0.71f)
                curveToRelative(0.39f, 0.39f, 0.39f, 1.02f, 0.0f, 1.41f)
                lineToRelative(-0.71f, 0.71f)
                lineTo(18.01f, 12.87f)
                close()
                moveTo(17.3f, 13.58f)
                lineToRelative(-5.3f, 5.3f)
                verticalLineTo(21.0f)
                horizontalLineToRelative(2.12f)
                lineToRelative(5.3f, -5.3f)
                lineTo(17.3f, 13.58f)
                close()
            }
        }
        return _editNote!!
    }

private var _editNote: ImageVector? = null

public val Icons.Outlined.Event: ImageVector
    get() {
        if (_event != null) {
            return _event!!
        }
        _event = materialIcon(name = "Outlined.Event") {
            materialPath {
                moveTo(19.0f, 4.0f)
                horizontalLineToRelative(-1.0f)
                lineTo(18.0f, 2.0f)
                horizontalLineToRelative(-2.0f)
                verticalLineToRelative(2.0f)
                lineTo(8.0f, 4.0f)
                lineTo(8.0f, 2.0f)
                lineTo(6.0f, 2.0f)
                verticalLineToRelative(2.0f)
                lineTo(5.0f, 4.0f)
                curveToRelative(-1.11f, 0.0f, -1.99f, 0.9f, -1.99f, 2.0f)
                lineTo(3.0f, 20.0f)
                curveToRelative(0.0f, 1.1f, 0.89f, 2.0f, 2.0f, 2.0f)
                horizontalLineToRelative(14.0f)
                curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
                lineTo(21.0f, 6.0f)
                curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
                close()
                moveTo(19.0f, 20.0f)
                lineTo(5.0f, 20.0f)
                lineTo(5.0f, 10.0f)
                horizontalLineToRelative(14.0f)
                verticalLineToRelative(10.0f)
                close()
                moveTo(19.0f, 8.0f)
                lineTo(5.0f, 8.0f)
                lineTo(5.0f, 6.0f)
                horizontalLineToRelative(14.0f)
                verticalLineToRelative(2.0f)
                close()
                moveTo(12.0f, 13.0f)
                horizontalLineToRelative(5.0f)
                verticalLineToRelative(5.0f)
                horizontalLineToRelative(-5.0f)
                close()
            }
        }
        return _event!!
    }

private var _event: ImageVector? = null

public val Icons.Outlined.FormatQuote: ImageVector
    get() {
        if (_formatQuote != null) {
            return _formatQuote!!
        }
        _formatQuote = materialIcon(name = "Outlined.FormatQuote") {
            materialPath {
                moveTo(18.62f, 18.0f)
                horizontalLineToRelative(-5.24f)
                lineToRelative(2.0f, -4.0f)
                lineTo(13.0f, 14.0f)
                lineTo(13.0f, 6.0f)
                horizontalLineToRelative(8.0f)
                verticalLineToRelative(7.24f)
                lineTo(18.62f, 18.0f)
                close()
                moveTo(16.62f, 16.0f)
                horizontalLineToRelative(0.76f)
                lineTo(19.0f, 12.76f)
                lineTo(19.0f, 8.0f)
                horizontalLineToRelative(-4.0f)
                verticalLineToRelative(4.0f)
                horizontalLineToRelative(3.62f)
                lineToRelative(-2.0f, 4.0f)
                close()
                moveTo(8.62f, 18.0f)
                lineTo(3.38f, 18.0f)
                lineToRelative(2.0f, -4.0f)
                lineTo(3.0f, 14.0f)
                lineTo(3.0f, 6.0f)
                horizontalLineToRelative(8.0f)
                verticalLineToRelative(7.24f)
                lineTo(8.62f, 18.0f)
                close()
                moveTo(6.62f, 16.0f)
                horizontalLineToRelative(0.76f)
                lineTo(9.0f, 12.76f)
                lineTo(9.0f, 8.0f)
                lineTo(5.0f, 8.0f)
                verticalLineToRelative(4.0f)
                horizontalLineToRelative(3.62f)
                lineToRelative(-2.0f, 4.0f)
                close()
            }
        }
        return _formatQuote!!
    }

private var _formatQuote: ImageVector? = null

public val Icons.Outlined.OpenInNew: ImageVector
    get() {
        if (_openInNew != null) {
            return _openInNew!!
        }
        _openInNew = materialIcon(name = "Outlined.OpenInNew") {
            materialPath {
                moveTo(19.0f, 19.0f)
                horizontalLineTo(5.0f)
                verticalLineTo(5.0f)
                horizontalLineToRelative(7.0f)
                verticalLineTo(3.0f)
                horizontalLineTo(5.0f)
                curveToRelative(-1.11f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
                verticalLineToRelative(14.0f)
                curveToRelative(0.0f, 1.1f, 0.89f, 2.0f, 2.0f, 2.0f)
                horizontalLineToRelative(14.0f)
                curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
                verticalLineToRelative(-7.0f)
                horizontalLineToRelative(-2.0f)
                verticalLineToRelative(7.0f)
                close()
                moveTo(14.0f, 3.0f)
                verticalLineToRelative(2.0f)
                horizontalLineToRelative(3.59f)
                lineToRelative(-9.83f, 9.83f)
                lineToRelative(1.41f, 1.41f)
                lineTo(19.0f, 6.41f)
                verticalLineTo(10.0f)
                horizontalLineToRelative(2.0f)
                verticalLineTo(3.0f)
                horizontalLineToRelative(-7.0f)
                close()
            }
        }
        return _openInNew!!
    }

private var _openInNew: ImageVector? = null

public val Icons.Outlined.PhonelinkLock: ImageVector
    get() {
        if (_phonelinkLock != null) {
            return _phonelinkLock!!
        }
        _phonelinkLock = materialIcon(name = "Outlined.PhonelinkLock") {
            materialPath {
                moveTo(19.0f, 1.0f)
                lineTo(9.0f, 1.0f)
                curveToRelative(-1.1f, 0.0f, -2.0f, 0.9f, -2.0f, 2.0f)
                verticalLineToRelative(3.0f)
                horizontalLineToRelative(2.0f)
                lineTo(9.0f, 4.0f)
                horizontalLineToRelative(10.0f)
                verticalLineToRelative(16.0f)
                lineTo(9.0f, 20.0f)
                verticalLineToRelative(-2.0f)
                lineTo(7.0f, 18.0f)
                verticalLineToRelative(3.0f)
                curveToRelative(0.0f, 1.1f, 0.9f, 2.0f, 2.0f, 2.0f)
                horizontalLineToRelative(10.0f)
                curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
                lineTo(21.0f, 3.0f)
                curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
                close()
                moveTo(10.8f, 11.0f)
                lineTo(10.8f, 9.5f)
                curveTo(10.8f, 8.1f, 9.4f, 7.0f, 8.0f, 7.0f)
                reflectiveCurveTo(5.2f, 8.1f, 5.2f, 9.5f)
                lineTo(5.2f, 11.0f)
                curveToRelative(-0.6f, 0.0f, -1.2f, 0.6f, -1.2f, 1.2f)
                verticalLineToRelative(3.5f)
                curveToRelative(0.0f, 0.7f, 0.6f, 1.3f, 1.2f, 1.3f)
                horizontalLineToRelative(5.5f)
                curveToRelative(0.7f, 0.0f, 1.3f, -0.6f, 1.3f, -1.2f)
                verticalLineToRelative(-3.5f)
                curveToRelative(0.0f, -0.7f, -0.6f, -1.3f, -1.2f, -1.3f)
                close()
                moveTo(9.5f, 11.0f)
                horizontalLineToRelative(-3.0f)
                lineTo(6.5f, 9.5f)
                curveToRelative(0.0f, -0.8f, 0.7f, -1.3f, 1.5f, -1.3f)
                reflectiveCurveToRelative(1.5f, 0.5f, 1.5f, 1.3f)
                lineTo(9.5f, 11.0f)
                close()
            }
        }
        return _phonelinkLock!!
    }

private var _phonelinkLock: ImageVector? = null

public val Icons.Outlined.Sync: ImageVector
    get() {
        if (_sync != null) {
            return _sync!!
        }
        _sync = materialIcon(name = "Outlined.Sync") {
            materialPath {
                moveTo(12.0f, 4.0f)
                lineTo(12.0f, 1.0f)
                lineTo(8.0f, 5.0f)
                lineToRelative(4.0f, 4.0f)
                lineTo(12.0f, 6.0f)
                curveToRelative(3.31f, 0.0f, 6.0f, 2.69f, 6.0f, 6.0f)
                curveToRelative(0.0f, 1.01f, -0.25f, 1.97f, -0.7f, 2.8f)
                lineToRelative(1.46f, 1.46f)
                curveTo(19.54f, 15.03f, 20.0f, 13.57f, 20.0f, 12.0f)
                curveToRelative(0.0f, -4.42f, -3.58f, -8.0f, -8.0f, -8.0f)
                close()
                moveTo(12.0f, 18.0f)
                curveToRelative(-3.31f, 0.0f, -6.0f, -2.69f, -6.0f, -6.0f)
                curveToRelative(0.0f, -1.01f, 0.25f, -1.97f, 0.7f, -2.8f)
                lineTo(5.24f, 7.74f)
                curveTo(4.46f, 8.97f, 4.0f, 10.43f, 4.0f, 12.0f)
                curveToRelative(0.0f, 4.42f, 3.58f, 8.0f, 8.0f, 8.0f)
                verticalLineToRelative(3.0f)
                lineToRelative(4.0f, -4.0f)
                lineToRelative(-4.0f, -4.0f)
                verticalLineToRelative(3.0f)
                close()
            }
        }
        return _sync!!
    }

private var _sync: ImageVector? = null

public val Icons.Outlined.Key: ImageVector
    get() {
        if (_key != null) {
            return _key!!
        }
        _key = materialIcon(name = "Outlined.Key") {
            materialPath {
                moveTo(21.0f, 10.0f)
                horizontalLineToRelative(-8.35f)
                curveTo(11.83f, 7.67f, 9.61f, 6.0f, 7.0f, 6.0f)
                curveToRelative(-3.31f, 0.0f, -6.0f, 2.69f, -6.0f, 6.0f)
                reflectiveCurveToRelative(2.69f, 6.0f, 6.0f, 6.0f)
                curveToRelative(2.61f, 0.0f, 4.83f, -1.67f, 5.65f, -4.0f)
                horizontalLineTo(13.0f)
                lineToRelative(2.0f, 2.0f)
                lineToRelative(2.0f, -2.0f)
                lineToRelative(2.0f, 2.0f)
                lineToRelative(4.0f, -4.04f)
                lineTo(21.0f, 10.0f)
                close()
                moveTo(7.0f, 15.0f)
                curveToRelative(-1.65f, 0.0f, -3.0f, -1.35f, -3.0f, -3.0f)
                curveToRelative(0.0f, -1.65f, 1.35f, -3.0f, 3.0f, -3.0f)
                reflectiveCurveToRelative(3.0f, 1.35f, 3.0f, 3.0f)
                curveTo(10.0f, 13.65f, 8.65f, 15.0f, 7.0f, 15.0f)
                close()
            }
        }
        return _key!!
    }

private var _key: ImageVector? = null

public val Icons.Outlined.Shield: ImageVector
    get() {
        if (_shield != null) {
            return _shield!!
        }
        _shield = materialIcon(name = "Outlined.Shield") {
            materialPath {
                moveTo(12.0f, 2.0f)
                lineTo(4.0f, 5.0f)
                verticalLineToRelative(6.09f)
                curveToRelative(0.0f, 5.05f, 3.41f, 9.76f, 8.0f, 10.91f)
                curveToRelative(4.59f, -1.15f, 8.0f, -5.86f, 8.0f, -10.91f)
                verticalLineTo(5.0f)
                lineTo(12.0f, 2.0f)
                close()
                moveTo(18.0f, 11.09f)
                curveToRelative(0.0f, 4.0f, -2.55f, 7.7f, -6.0f, 8.83f)
                curveToRelative(-3.45f, -1.13f, -6.0f, -4.82f, -6.0f, -8.83f)
                verticalLineToRelative(-4.7f)
                lineToRelative(6.0f, -2.25f)
                lineToRelative(6.0f, 2.25f)
                verticalLineTo(11.09f)
                close()
            }
        }
        return _shield!!
    }

private var _shield: ImageVector? = null

public val Icons.AutoMirrored.Outlined.Message: ImageVector
    get() {
        if (_message != null) {
            return _message!!
        }
        _message = materialIcon(name = "AutoMirrored.Outlined.Message", autoMirror = true) {
            materialPath {
                moveTo(4.0f, 4.0f)
                horizontalLineToRelative(16.0f)
                verticalLineToRelative(12.0f)
                lineTo(5.17f, 16.0f)
                lineTo(4.0f, 17.17f)
                lineTo(4.0f, 4.0f)
                moveToRelative(0.0f, -2.0f)
                curveToRelative(-1.1f, 0.0f, -1.99f, 0.9f, -1.99f, 2.0f)
                lineTo(2.0f, 22.0f)
                lineToRelative(4.0f, -4.0f)
                horizontalLineToRelative(14.0f)
                curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
                lineTo(22.0f, 4.0f)
                curveToRelative(0.0f, -1.1f, -0.9f, -2.0f, -2.0f, -2.0f)
                lineTo(4.0f, 2.0f)
                close()
                moveTo(6.0f, 12.0f)
                horizontalLineToRelative(12.0f)
                verticalLineToRelative(2.0f)
                lineTo(6.0f, 14.0f)
                verticalLineToRelative(-2.0f)
                close()
                moveTo(6.0f, 9.0f)
                horizontalLineToRelative(12.0f)
                verticalLineToRelative(2.0f)
                lineTo(6.0f, 11.0f)
                lineTo(6.0f, 9.0f)
                close()
                moveTo(6.0f, 6.0f)
                horizontalLineToRelative(12.0f)
                verticalLineToRelative(2.0f)
                lineTo(6.0f, 8.0f)
                lineTo(6.0f, 6.0f)
                close()
            }
        }
        return _message!!
    }

private var _message: ImageVector? = null

public val Icons.Filled.ChevronRight: ImageVector
    get() {
        if (_chevronRight != null) {
            return _chevronRight!!
        }
        _chevronRight = materialIcon(name = "Filled.ChevronRight") {
            materialPath {
                moveTo(10.0f, 6.0f)
                lineTo(8.59f, 7.41f)
                lineTo(13.17f, 12.0f)
                lineToRelative(-4.58f, 4.59f)
                lineTo(10.0f, 18.0f)
                lineToRelative(6.0f, -6.0f)
                close()
            }
        }
        return _chevronRight!!
    }

private var _chevronRight: ImageVector? = null
