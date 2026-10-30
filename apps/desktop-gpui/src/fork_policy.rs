pub const FORK: bool = cfg!(feature = "ux-walk");

pub const fn link(upstream: &'static str, fork: &'static str) -> &'static str {
    if FORK { fork } else { upstream }
}

pub fn upstream_only<T>(build: impl FnOnce() -> T) -> Option<T> {
    (!FORK).then(build)
}
