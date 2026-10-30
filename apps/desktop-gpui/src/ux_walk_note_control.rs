use std::future::Future;

#[derive(Default)]
pub(crate) struct StopNoteFence {
    generation: Option<u64>,
}

impl StopNoteFence {
    pub(crate) fn begin(&mut self, generation: u64) -> bool {
        if self.generation.is_some() {
            return false;
        }
        self.generation = Some(generation);
        true
    }

    pub(crate) fn pending(&self) -> bool {
        self.generation.is_some()
    }

    pub(crate) fn complete(&mut self, generation: u64, recording: bool) -> bool {
        if !recording || self.generation != Some(generation) {
            return false;
        }
        self.generation = None;
        true
    }

    pub(crate) fn invalidate(&mut self) {
        self.generation = None;
    }
}

pub(crate) async fn after_note_fence<E>(
    fence: impl Future<Output = Result<(), E>>,
    control: impl Future<Output = Result<(), E>>,
) -> Result<(), E> {
    let source = fence.await;
    let media = control.await;
    media.and(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{Future, poll_fn},
        pin::pin,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        task::{Context, Poll, Wake, Waker},
    };

    struct NoopWake;
    impl Wake for NoopWake {
        fn wake(self: Arc<Self>) {}
    }

    #[test]
    fn stop_fence_continues_only_once_for_its_recording_generation() {
        let mut fence = StopNoteFence::default();
        assert!(fence.begin(1));
        assert!(!fence.begin(1));
        assert!(fence.pending());
        assert!(!fence.complete(2, true));
        assert!(!fence.complete(1, false));
        assert!(fence.complete(1, true));
        assert!(!fence.pending());
        assert!(!fence.complete(1, true));
        assert!(fence.begin(2));
        fence.invalidate();
        assert!(fence.begin(3));
        assert!(!fence.complete(2, true));
        assert!(fence.complete(3, true));
    }

    #[test]
    fn media_control_is_not_polled_before_the_source_acknowledges() {
        let acknowledged = Arc::new(AtomicBool::new(false));
        let source = acknowledged.clone();
        let controlled = Arc::new(AtomicBool::new(false));
        let observed = controlled.clone();
        let mut operation = pin!(after_note_fence(
            poll_fn(move |_| {
                if source.load(Ordering::SeqCst) {
                    Poll::Ready(Ok::<(), &'static str>(()))
                } else {
                    Poll::Pending
                }
            }),
            async move {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
        ));
        let waker = Waker::from(Arc::new(NoopWake));
        let mut context = Context::from_waker(&waker);
        assert!(operation.as_mut().poll(&mut context).is_pending());
        assert!(!controlled.load(Ordering::SeqCst));
        acknowledged.store(true, Ordering::SeqCst);
        assert_eq!(operation.as_mut().poll(&mut context), Poll::Ready(Ok(())));
        assert!(controlled.load(Ordering::SeqCst));
    }

    #[test]
    fn failed_source_ack_still_runs_requested_media_shutdown() {
        let controlled = Arc::new(AtomicBool::new(false));
        let observed = controlled.clone();
        let mut operation = pin!(after_note_fence(async { Err("source timeout") }, async move {
            observed.store(true, Ordering::SeqCst);
            Ok(())
        }));
        let waker = Waker::from(Arc::new(NoopWake));
        let mut context = Context::from_waker(&waker);
        assert_eq!(operation.as_mut().poll(&mut context), Poll::Ready(Err("source timeout")));
        assert!(controlled.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelled_preflight_never_polls_its_media_control() {
        let controlled = Arc::new(AtomicBool::new(false));
        let observed = controlled.clone();
        let mut operation = Box::pin(after_note_fence(
            std::future::pending::<Result<(), &'static str>>(),
            async move {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
        ));
        let waker = Waker::from(Arc::new(NoopWake));
        let mut context = Context::from_waker(&waker);
        assert!(operation.as_mut().poll(&mut context).is_pending());
        drop(operation);
        assert!(!controlled.load(Ordering::SeqCst));
    }
}
