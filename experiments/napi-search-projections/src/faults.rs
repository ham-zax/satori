//! Deterministic test controls. This module does not exist in default builds.
use super::*;
use std::sync::{Condvar, Mutex};

#[derive(Default)]
struct State {
    released: Mutex<bool>,
    wake: Condvar,
    started: AtomicBool,
    finished: AtomicBool,
    observed_cancel: AtomicBool,
}
#[napi]
#[derive(Default)]
pub struct ProjectionBarrier {
    state: Arc<State>,
}
#[napi]
impl ProjectionBarrier {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    #[napi]
    pub fn started(&self) -> bool {
        self.state.started.load(Ordering::Acquire)
    }
    #[napi]
    pub fn finished(&self) -> bool {
        self.state.finished.load(Ordering::Acquire)
    }
    #[napi]
    pub fn observed_cancel(&self) -> bool {
        self.state.observed_cancel.load(Ordering::Acquire)
    }
    #[napi]
    pub fn release(&self) {
        *self.state.released.lock().expect("barrier lock") = true;
        self.state.wake.notify_all();
    }
}
#[derive(Default)]
pub(super) struct Faults {
    fail: Option<u32>,
    panic: Option<u32>,
    barrier: Option<Arc<State>>,
}
impl Faults {
    pub(super) fn wait(&self) {
        if let Some(state) = &self.barrier {
            let mut released = state.released.lock().expect("barrier lock");
            state.started.store(true, Ordering::Release);
            while !*released {
                released = state.wake.wait(released).expect("barrier wait");
            }
        }
    }
    pub(super) fn at(&self, index: usize) -> Result<()> {
        assert_ne!(self.panic, Some(index as u32), "injected projection panic");
        if self.fail == Some(index as u32) {
            return Err(Error::from_reason("injected projection failure"));
        }
        Ok(())
    }
    pub(super) fn finish(&self, cancelled: bool) {
        if let Some(state) = &self.barrier {
            state.observed_cancel.store(cancelled, Ordering::Release);
            state.finished.store(true, Ordering::Release);
        }
    }
}
#[napi]
pub fn build_projection_batch_for_test(
    inputs: Vec<ProjectionInput>,
    token: &ProjectionCancellation,
    fail_at_index: Option<u32>,
    panic_at_index: Option<u32>,
    barrier: Option<&ProjectionBarrier>,
    output_limit: Option<u32>,
) -> Result<AsyncTask<ProjectionTask>> {
    let mut task = task(inputs, Some(token))?;
    task.faults = Faults {
        fail: fail_at_index,
        panic: panic_at_index,
        barrier: barrier.map(|b| b.state.clone()),
    };
    if let Some(limit) = output_limit {
        task.output_limit = (limit as usize).min(MAX_OUTPUT);
    }
    Ok(AsyncTask::new(task))
}
