//! Per-operation receive rate. Feed cumulative transport bytes, not plaintext:
//! authenticated decryption can buffer a whole record before progress advances.
use std::time::{Duration, Instant};

pub(crate) struct TransferRate {
    sampled_at: Instant,
    sampled_bytes: u64,
    speed: u64,
}

impl TransferRate {
    pub(crate) fn new() -> Self {
        Self {
            sampled_at: Instant::now(),
            sampled_bytes: 0,
            speed: 0,
        }
    }

    pub(crate) fn record(&mut self, received: u64) -> u64 {
        let now = Instant::now();
        if received < self.sampled_bytes {
            // A restarted operation must not inherit another attempt's rate.
            self.sampled_at = now;
            self.sampled_bytes = received;
            self.speed = 0;
            return 0;
        }
        let elapsed = now.duration_since(self.sampled_at);
        let delta = received - self.sampled_bytes;
        if elapsed >= Duration::from_millis(250) || (self.speed == 0 && delta > 0) {
            self.speed = (delta as f64 / elapsed.as_secs_f64().max(f64::EPSILON)) as u64;
            self.sampled_at = now;
            self.sampled_bytes = received;
        }
        self.speed
    }
}
