package com.lifttrace.app.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.LayoutElementBuilders.Column
import androidx.wear.protolayout.LayoutElementBuilders.FONT_WEIGHT_BOLD
import androidx.wear.protolayout.LayoutElementBuilders.FontStyle
import androidx.wear.protolayout.LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER
import androidx.wear.protolayout.LayoutElementBuilders.Spacer
import androidx.wear.protolayout.LayoutElementBuilders.Text
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A tile: the set you are on, one swipe from the watch face.
 *
 * Drawn from the session the app last saved, so it appears instantly and reads
 * correctly in a basement gym with no signal. Tapping it opens the app, which
 * refreshes and sends anything still waiting.
 */
class SessionTileService : TileService() {

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        Futures.immediateFuture(ResourceBuilders.Resources.Builder().setVersion(RES_VERSION).build())

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> {
        val paired = Pairing.config(this) != null
        val workout = Pairing.cache(this)?.let { runCatching { Session.parse(it) }.getOrNull() }
        val next = Session.next(workout)

        val headline: String
        val detail: String
        when {
            !paired -> {
                headline = "Pair from your phone"
                detail = "Sign in on the phone app"
            }
            workout == null -> {
                headline = "Nothing planned"
                detail = "Today has no session"
            }
            next != null -> {
                headline = next.exercise.name
                detail = "Set ${next.setNumber} of ${next.exercise.total} · ${Session.progress(workout)} sets"
            }
            else -> {
                headline = "Session done"
                detail = "${Session.progress(workout)} sets"
            }
        }

        val openApp = ModifiersBuilders.Modifiers.Builder()
            .setClickable(
                ModifiersBuilders.Clickable.Builder()
                    .setId("open")
                    .setOnClick(
                        ActionBuilders.LaunchAction.Builder()
                            .setAndroidActivity(
                                ActionBuilders.AndroidActivity.Builder()
                                    .setPackageName(packageName)
                                    .setClassName(MainActivity::class.java.name)
                                    .build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()

        val layout = Column.Builder()
            .setModifiers(openApp)
            .setHorizontalAlignment(HORIZONTAL_ALIGN_CENTER)
            .addContent(
                Text.Builder()
                    .setText(workout?.name?.takeIf { paired } ?: "LiftTrace")
                    .setMaxLines(1)
                    .setFontStyle(FontStyle.Builder().setSize(sp(13f)).setColor(argb(0xFF4DD6E0.toInt())).build())
                    .build(),
            )
            .addContent(Spacer.Builder().setHeight(dp(6f)).build())
            .addContent(
                Text.Builder()
                    .setText(headline)
                    .setMaxLines(2)
                    .setFontStyle(
                        FontStyle.Builder().setSize(sp(20f)).setWeight(FONT_WEIGHT_BOLD)
                            .setColor(argb(0xFFFFFFFF.toInt())).build(),
                    )
                    .build(),
            )
            .addContent(Spacer.Builder().setHeight(dp(4f)).build())
            .addContent(
                Text.Builder()
                    .setText(detail)
                    .setMaxLines(2)
                    .setFontStyle(FontStyle.Builder().setSize(sp(14f)).setColor(argb(0xFFB6BAC6.toInt())).build())
                    .build(),
            )
            .build()

        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RES_VERSION)
            // The app saves a new session whenever it opens or a set is logged;
            // ten minutes keeps the tile honest without waking anything.
            .setFreshnessIntervalMillis(10 * 60 * 1000)
            .setTileTimeline(
                TimelineBuilders.Timeline.Builder()
                    .addTimelineEntry(
                        TimelineBuilders.TimelineEntry.Builder()
                            .setLayout(
                                LayoutElementBuilders.Layout.Builder().setRoot(layout).build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()
        return Futures.immediateFuture(tile)
    }

    companion object {
        private const val RES_VERSION = "1"

        /** Ask the system to redraw the tile after the app saves a new session. */
        fun refresh(ctx: android.content.Context) {
            runCatching { getUpdater(ctx).requestUpdate(SessionTileService::class.java) }
        }
    }
}
