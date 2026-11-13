package com.lifttrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Local mode (#156): what the watch makes of the phone's reply. */
class PhoneAnswerTest {
    private fun reply(status: Int, body: String) =
        org.json.JSONObject().put("status", status).put("body", body).toString().toByteArray()

    @Test fun anAnswerIsTheBody() {
        assertEquals("{\"workout\":null}", LiftApi.readPhoneAnswer(reply(200, "{\"workout\":null}")))
    }

    @Test fun anAppNotReadyOrTooSlowKeepsTheSetLikeNoConnection() {
        for (status in listOf(503, 504)) {
            try { LiftApi.readPhoneAnswer(reply(status, "{}")); fail() } catch (e: LiftApi.PhoneUnavailable) {
                assertEquals("Open LiftTrace on your phone", e.message)
            }
        }
        try { LiftApi.readPhoneAnswer("not json".toByteArray()); fail() } catch (e: LiftApi.PhoneUnavailable) { }
    }

    @Test fun aRefusalSaysWhyAndIsNotSignedOut() {
        try { LiftApi.readPhoneAnswer(reply(409, "{\"error\":\"The phone is connected to a server now.\"}")); fail() } catch (e: LiftApi.ApiError) {
            assertEquals(409, e.code)
            assertEquals("The phone is connected to a server now.", e.message)
            assertTrue(e.code != 401 && e.code != 403)
        }
    }

    @Test fun theAddressMatchesThePhones() {
        assertEquals("phone:", Pairing.PHONE)
        assertTrue(Pairing.Config(Pairing.PHONE, "local").viaPhone)
        assertTrue(!Pairing.Config("https://lift.example", "t").viaPhone)
    }
}
