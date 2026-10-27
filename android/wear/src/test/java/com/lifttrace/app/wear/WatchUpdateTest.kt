package com.lifttrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Test

/** Releases compared as the phone's updater compares them (updates.js). */
class WatchUpdateTest {
    @Test fun aLaterDevBuildIsNewer() {
        assertEquals(1, WatchUpdate.compare("v1.4.0-dev05", "v1.4.0-dev04"))
        assertEquals(-1, WatchUpdate.compare("v1.4.0-dev04", "v1.4.0-dev05"))
        assertEquals(1, WatchUpdate.compare("v1.4.0-dev10", "v1.4.0-dev09"))
    }

    @Test fun aReleaseOutranksItsOwnDevBuilds() {
        assertEquals(1, WatchUpdate.compare("v1.4.0", "v1.4.0-dev05"))
        assertEquals(-1, WatchUpdate.compare("v1.4.0-dev05", "v1.4.0"))
        assertEquals(1, WatchUpdate.compare("v1.4.1-dev01", "v1.4.0"))
    }

    @Test fun theSameOrUnreadableIsNoUpdate() {
        assertEquals(0, WatchUpdate.compare("v1.4.0-dev05", "v1.4.0-dev05"))
        assertEquals(0, WatchUpdate.compare("dev-latest", "v1.4.0"))
        assertEquals(0, WatchUpdate.compare("", "v1.4.0"))
    }

    @Test fun theWatchBuildIsNamedAsTheReleaseNamesIt() {
        assertEquals("lifttrace-wear-v1.4.0-dev05.apk", WatchUpdate.assetName("v1.4.0-dev05"))
    }
}
