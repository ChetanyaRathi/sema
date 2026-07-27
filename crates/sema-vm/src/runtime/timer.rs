use std::collections::BTreeMap;
// See the comment on this same import in `host_api.rs`: a wasm32-safe
// `Instant` substitute used throughout `crate::runtime`.
use web_time::Instant;

use hashbrown::HashMap;

use super::WaitKey;

#[derive(Default)]
pub struct TimerQueue {
    deadlines: BTreeMap<(Instant, u64), WaitKey>,
    reverse: HashMap<WaitKey, (Instant, u64)>,
    next_sequence: u64,
    #[cfg(test)]
    reject_next_insert_as_duplicate: bool,
}

impl TimerQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, deadline: Instant, key: WaitKey) -> bool {
        #[cfg(test)]
        if std::mem::take(&mut self.reject_next_insert_as_duplicate) {
            return false;
        }
        if self.reverse.contains_key(&key) {
            return false;
        }
        let timer_key = (deadline, self.next_sequence);
        let Some(next_sequence) = self.next_sequence.checked_add(1) else {
            return false;
        };
        self.next_sequence = next_sequence;
        self.reverse.insert(key, timer_key);
        self.deadlines.insert(timer_key, key);
        true
    }

    pub fn cancel(&mut self, key: WaitKey) -> bool {
        let Some(timer_key) = self.reverse.remove(&key) else {
            return false;
        };
        let removed = self.deadlines.remove(&timer_key);
        debug_assert_eq!(removed, Some(key));
        true
    }

    pub fn pop_due(&mut self, now: Instant) -> Option<WaitKey> {
        let timer_key = *self.deadlines.first_key_value()?.0;
        let deadline = timer_key.0;
        if deadline > now {
            return None;
        }
        let key = self.deadlines.remove(&timer_key)?;
        self.reverse.remove(&key);
        Some(key)
    }

    /// The earliest due timer whose key satisfies `matches`, without removing
    /// it — the read half of a filtered pop, so the caller can hold an
    /// immutable borrow of the rest of the runtime state while deciding
    /// (`cancel` then removes it). Mirrors [`next_deadline_for`]: entries that
    /// don't match are skipped rather than blocking the ones behind them, so a
    /// root-filtered drive never observes another root's timer.
    ///
    /// [`next_deadline_for`]: Self::next_deadline_for
    pub fn peek_due_for(&self, now: Instant, matches: impl Fn(WaitKey) -> bool) -> Option<WaitKey> {
        self.deadlines
            .iter()
            .find(|(&(deadline, _), &key)| deadline <= now && matches(key))
            .map(|(_, &key)| key)
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.next_deadline_for(|_| true)
    }

    pub fn next_deadline_for(&self, matches: impl Fn(WaitKey) -> bool) -> Option<Instant> {
        self.deadlines
            .iter()
            .find_map(|(&(deadline, _), &key)| matches(key).then_some(deadline))
    }

    pub fn is_empty(&self) -> bool {
        self.reverse.is_empty()
    }

    pub fn scheduled_len(&self) -> usize {
        self.reverse.len()
    }

    #[cfg(test)]
    pub fn force_sequence_exhaustion_for_test(&mut self) {
        self.next_sequence = u64::MAX;
    }

    #[cfg(test)]
    pub fn force_duplicate_for_test(&mut self) {
        self.reject_next_insert_as_duplicate = true;
    }
}
