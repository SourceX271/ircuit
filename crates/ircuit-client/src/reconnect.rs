//! Reconnection backoff.
//!
//! A dropped connection is normal — laptops sleep, wifi roams, servers restart.
//! What is not normal is every client of a network reconnecting at the same
//! instant after that network comes back: that is a self-inflicted denial of
//! service. So the delay grows exponentially *and* carries jitter.
//!
//! Jitter is derived from a caller-supplied seed rather than a random number
//! generator, which keeps this module pure and therefore testable.

use std::time::Duration;

/// How long to wait before each reconnection attempt.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackoffPolicy {
    /// Delay before the first retry.
    pub initial: Duration,
    /// Ceiling for the delay, however many attempts have failed.
    pub max: Duration,
    /// Growth factor applied per attempt. Values below 1 are treated as 1.
    pub multiplier: f64,
    /// Fraction of the delay that may be shaved off, in `0.0..1.0`.
    pub jitter: f64,
}

impl Default for BackoffPolicy {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(120),
            multiplier: 2.0,
            jitter: 0.2,
        }
    }
}

impl BackoffPolicy {
    /// A policy that never waits, for tests and for manual "reconnect now".
    #[must_use]
    pub fn immediate() -> Self {
        Self {
            initial: Duration::ZERO,
            max: Duration::ZERO,
            multiplier: 1.0,
            jitter: 0.0,
        }
    }

    /// Delay before attempt number `attempt`, where the first retry is `1`.
    ///
    /// `seed` should change between calls (the current time is fine); it only
    /// needs to decorrelate clients from each other.
    #[must_use]
    pub fn delay(&self, attempt: u32, seed: u64) -> Duration {
        let base = self.base_delay(attempt);
        if base.is_zero() || self.jitter <= 0.0 {
            return base;
        }

        // Deterministic per (seed, attempt), in `0.0..1.0`.
        let noise = pseudo_random_fraction(seed ^ u64::from(attempt));
        let factor = 1.0 - self.jitter * noise;

        base.mul_f64(factor.clamp(0.0, 1.0))
    }

    /// The delay without jitter — the value the schedule converges to.
    #[must_use]
    pub fn base_delay(&self, attempt: u32) -> Duration {
        if attempt == 0 {
            return Duration::ZERO;
        }

        let multiplier = self.multiplier.max(1.0);
        let factor = multiplier.powi(attempt.saturating_sub(1) as i32);

        // `as_secs_f64` keeps sub-second initial delays meaningful.
        let seconds = self.initial.as_secs_f64() * factor;
        let capped = seconds.min(self.max.as_secs_f64());

        Duration::from_secs_f64(capped)
    }
}

/// A cheap, well-distributed fraction in `0.0..1.0`.
///
/// SplitMix64's finalizer: it is a handful of instructions, needs no state, and
/// is more than good enough to keep retry storms from synchronising.
fn pseudo_random_fraction(seed: u64) -> f64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;

    // Top 53 bits give a uniform double without bias.
    (z >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_attempt_is_immediate() {
        assert_eq!(BackoffPolicy::default().base_delay(0), Duration::ZERO);
    }

    #[test]
    fn delay_grows_exponentially() {
        let policy = BackoffPolicy {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(300),
            multiplier: 2.0,
            jitter: 0.0,
        };

        assert_eq!(policy.base_delay(1), Duration::from_secs(1));
        assert_eq!(policy.base_delay(2), Duration::from_secs(2));
        assert_eq!(policy.base_delay(3), Duration::from_secs(4));
        assert_eq!(policy.base_delay(4), Duration::from_secs(8));
    }

    #[test]
    fn delay_is_capped() {
        let policy = BackoffPolicy {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(10),
            multiplier: 2.0,
            jitter: 0.0,
        };

        assert_eq!(policy.base_delay(4), Duration::from_secs(8));
        assert_eq!(policy.base_delay(5), Duration::from_secs(10));
        assert_eq!(policy.base_delay(50), Duration::from_secs(10));
    }

    #[test]
    fn multiplier_below_one_cannot_shrink_the_delay() {
        let policy = BackoffPolicy {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(60),
            multiplier: 0.5,
            jitter: 0.0,
        };

        assert_eq!(policy.base_delay(3), Duration::from_secs(1));
    }

    #[test]
    fn jitter_stays_within_the_configured_band() {
        let policy = BackoffPolicy {
            initial: Duration::from_secs(10),
            max: Duration::from_secs(60),
            multiplier: 2.0,
            jitter: 0.2,
        };

        let base = policy.base_delay(1);
        for seed in 0..500u64 {
            let delay = policy.delay(1, seed);
            assert!(delay <= base, "jitter must never exceed the base delay");
            assert!(
                delay >= base.mul_f64(0.8),
                "jitter of {delay:?} fell below the 80% floor of {base:?}"
            );
        }
    }

    #[test]
    fn different_seeds_produce_different_delays() {
        let policy = BackoffPolicy::default();
        let a = policy.delay(3, 1);
        let b = policy.delay(3, 2);
        let c = policy.delay(3, 3);

        assert!(
            a != b || b != c,
            "jitter is not decorrelating clients at all"
        );
    }

    #[test]
    fn immediate_policy_never_waits() {
        let policy = BackoffPolicy::immediate();
        for attempt in 0..10 {
            assert_eq!(policy.delay(attempt, 42), Duration::ZERO);
        }
    }

    #[test]
    fn fraction_is_in_range_and_well_spread() {
        let mut buckets = [0usize; 4];
        for seed in 0..1000u64 {
            let value = pseudo_random_fraction(seed);
            assert!((0.0..1.0).contains(&value));
            buckets[(value * 4.0) as usize] += 1;
        }

        // Each quartile should get a meaningful share; a broken hash collapses
        // everything into one bucket.
        for count in buckets {
            assert!(count > 150, "distribution is skewed: {buckets:?}");
        }
    }
}
