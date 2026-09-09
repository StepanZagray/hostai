package com.hostai.backend;

import org.junit.jupiter.api.Test;

class CoreTest {
    @Test void endpointValidation() { CoreChecks.endpointValidation(); }
    @Test void admissionAndTerminalStates() { CoreChecks.admissionAndTerminalStates(); }
    @Test void boundedNewestFirstHistory() { CoreChecks.boundedNewestFirstHistory(); }
    @Test void concurrentFinishesReleaseExactlyOnce() throws Exception {
        CoreChecks.concurrentFinishesReleaseExactlyOnce();
    }
}
