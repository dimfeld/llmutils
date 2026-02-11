import Foundation
import Testing

@testable import TimGUI

@Suite("SessionDetailView.shouldAutoScroll")
struct AutoScrollTests {
    @Test("returns nil when viewportHeight is zero")
    func viewportHeightZero() {
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 500,
            viewportHeight: 0
        )
        #expect(result == nil)
    }

    @Test("returns true when content bottom equals viewport height (at bottom)")
    func atExactBottom() {
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 600,
            viewportHeight: 600
        )
        #expect(result == true)
    }

    @Test("returns true when within threshold (near bottom)")
    func nearBottom() {
        // contentMaxY - viewportHeight = 30, which is <= 50 threshold
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 630,
            viewportHeight: 600
        )
        #expect(result == true)
    }

    @Test("returns true at exact threshold boundary")
    func atThresholdBoundary() {
        // contentMaxY - viewportHeight = 50, which is <= 50 threshold
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 650,
            viewportHeight: 600
        )
        #expect(result == true)
    }

    @Test("returns false when scrolled up beyond threshold")
    func scrolledUp() {
        // contentMaxY - viewportHeight = 200, which is > 50 threshold
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 800,
            viewportHeight: 600
        )
        #expect(result == false)
    }

    @Test("returns true when content is shorter than viewport")
    func contentShorterThanViewport() {
        // contentMaxY < viewportHeight means content fits entirely
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 300,
            viewportHeight: 600
        )
        #expect(result == true)
    }

    @Test("respects custom threshold")
    func customThreshold() {
        // contentMaxY - viewportHeight = 80, threshold = 100 → true
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 680,
            viewportHeight: 600,
            threshold: 100
        )
        #expect(result == true)

        // Same offset but smaller threshold = 50 → false
        let result2 = SessionDetailView.shouldAutoScroll(
            contentMaxY: 680,
            viewportHeight: 600,
            threshold: 50
        )
        #expect(result2 == false)
    }

    @Test("returns false just beyond threshold")
    func justBeyondThreshold() {
        // contentMaxY - viewportHeight = 51, which is > 50 threshold
        let result = SessionDetailView.shouldAutoScroll(
            contentMaxY: 651,
            viewportHeight: 600
        )
        #expect(result == false)
    }
}
