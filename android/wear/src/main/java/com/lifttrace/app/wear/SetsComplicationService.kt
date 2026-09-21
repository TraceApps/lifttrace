package com.lifttrace.app.wear

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/**
 * Sets done, on the watch face itself.
 *
 * Reads the session the app last saved, so it costs nothing and is right as of
 * the last set logged. Tapping it opens LiftTrace.
 */
class SetsComplicationService : SuspendingComplicationDataSourceService() {

    companion object {
        /** The count changed: redraw whatever watch face is showing it. */
        fun refresh(ctx: android.content.Context) {
            runCatching {
                androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
                    .create(ctx, ComponentName(ctx, SetsComplicationService::class.java))
                    .requestUpdateAll()
            }
        }
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type != ComplicationType.SHORT_TEXT) null
        else shortText("3/12", "Sets", "3 of 12 sets done")

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        if (request.complicationType != ComplicationType.SHORT_TEXT) return null
        val workout = Pairing.cache(this)?.let { runCatching { Session.parse(it) }.getOrNull() }
            ?: return shortText("--", "Sets", "No session today")
        // A watch face has room for about five characters, so "3/12" rather
        // than "3 of 12"; the description reads the long way for a screen reader.
        return shortText(
            "${workout.setsDone}/${workout.setsTotal}",
            "Sets",
            "${workout.setsDone} of ${workout.setsTotal} sets done",
        )
    }

    private fun shortText(text: String, title: String, description: String): ComplicationData =
        ShortTextComplicationData.Builder(
            text = PlainComplicationText.Builder(text).build(),
            contentDescription = PlainComplicationText.Builder(description).build(),
        )
            .setTitle(PlainComplicationText.Builder(title).build())
            .setMonochromaticImage(
                MonochromaticImage.Builder(
                    android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_complication),
                ).build(),
            )
            .setTapAction(openApp())
            .build()

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent().apply {
            component = ComponentName(packageName, MainActivity::class.java.name)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        },
        PendingIntent.FLAG_IMMUTABLE,
    )
}
